// Sign in with Apple (App Store guideline 4.8): the iOS app gets an identity
// token from Apple and posts it here. We verify it against Apple's published
// keys and sign the person in. No dependency: Apple signs with RS256, which
// node:crypto verifies from the JWK directly.
//
// Account deletion must also revoke the person's Apple tokens (guideline
// 5.1.1(v)). That needs a "client secret" — a short JWT signed with a Sign in
// with Apple key from the developer account. When that key is configured, the
// authorization code the app sends is exchanged for a refresh token at sign-in
// and kept (encrypted) so deletion can revoke it. Without the key, sign-in still
// works; revocation is skipped with a warning.
import crypto from "node:crypto";
import fs from "node:fs";

const APPLE_ISSUER = "https://appleid.apple.com";

/** The app's bundle id is the token audience for native sign-in. More ids
 *  (a web Services ID, later) can be added comma-separated. */
export function appleAudiences(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.APPLE_CLIENT_IDS ?? "online.labee.mobile";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function jwksUrl(): string {
  return process.env.APPLE_JWKS_URL || `${APPLE_ISSUER}/auth/keys`;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function appleKeys(forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(jwksUrl(), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not reach Apple to verify sign-in (${res.status}).`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

/** Tests only: drop the cached keys. */
export function resetAppleKeyCache(): void {
  jwksCache = null;
}

function b64urlJson<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

export interface AppleIdentity {
  /** Stable for this person and this developer team. */
  sub: string;
  /** Real or private-relay address. Apple sends it on every sign-in once shared. */
  email: string | null;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

/** Verify an Apple identity token: signature, issuer, audience, expiry. */
export async function verifyAppleIdentityToken(token: string): Promise<AppleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed Apple identity token.");
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson<{ kid?: string; alg?: string }>(h);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unexpected Apple token algorithm.");

  let jwk = (await appleKeys()).find((k) => k.kid === header.kid);
  // Apple rotates keys; a kid we have not seen means our cache is stale.
  if (!jwk) jwk = (await appleKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Apple identity token was signed with an unknown key.");

  const key = crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("Apple identity token signature is invalid.");

  const claims = b64urlJson<{
    iss?: string;
    aud?: string | string[];
    exp?: number;
    sub?: string;
    email?: string;
    email_verified?: boolean | string;
    is_private_email?: boolean | string;
  }>(p);
  if (claims.iss !== APPLE_ISSUER) throw new Error("Apple identity token has the wrong issuer.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const allowed = appleAudiences();
  if (!aud.some((a) => typeof a === "string" && allowed.includes(a))) {
    throw new Error("Apple identity token was issued for a different app.");
  }
  // 60 s of leeway for clock skew between this server and Apple.
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) {
    throw new Error("Apple identity token has expired. Please sign in again.");
  }
  if (!claims.sub) throw new Error("Apple identity token has no user id.");

  const truthy = (v: unknown) => v === true || v === "true";
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" && claims.email ? claims.email : null,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email),
  };
}

// ---------------------------------------------------------------- revocation

interface SiwaKey {
  teamId: string;
  keyId: string;
  privateKey: string;
}

/** The Sign in with Apple private key, from APPLE_SIWA_PRIVATE_KEY (PEM text)
 *  or APPLE_SIWA_PRIVATE_KEY_FILE (path to the .p8). Null when unset. */
function siwaKey(env: NodeJS.ProcessEnv = process.env): SiwaKey | null {
  const keyId = env.APPLE_SIWA_KEY_ID;
  const teamId = env.APPLE_TEAM_ID || "W3X4ZUG72V";
  let privateKey = env.APPLE_SIWA_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";
  if (!privateKey && env.APPLE_SIWA_PRIVATE_KEY_FILE) {
    try {
      privateKey = fs.readFileSync(env.APPLE_SIWA_PRIVATE_KEY_FILE, "utf8");
    } catch {
      privateKey = "";
    }
  }
  if (!keyId || !privateKey.trim()) return null;
  return { teamId, keyId, privateKey };
}

export function appleRevocationConfigured(): boolean {
  return siwaKey() !== null;
}

/** The ES256 client secret Apple's token and revoke endpoints require. */
export function appleClientSecret(clientId: string, key: SiwaKey, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: key.keyId })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: key.teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: clientId }),
  ).toString("base64url");
  const sig = crypto
    .sign("sha256", Buffer.from(`${header}.${claims}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${claims}.${sig}`;
}

function nativeClientId(): string {
  return appleAudiences()[0]!;
}

/** Exchange the one-time authorization code for a refresh token, so deletion
 *  can revoke it later. Null when no key is configured or Apple refuses. */
export async function exchangeAppleCode(code: string): Promise<string | null> {
  const key = siwaKey();
  if (!key) return null;
  const clientId = nativeClientId();
  const res = await fetch(`${APPLE_ISSUER}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: appleClientSecret(clientId, key),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    console.warn(`[apple] code exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const body = (await res.json()) as { refresh_token?: string };
  return body.refresh_token ?? null;
}

/** Revoke a refresh token at Apple. True when Apple accepted it. */
export async function revokeAppleToken(refreshToken: string): Promise<boolean> {
  const key = siwaKey();
  if (!key) {
    console.warn("[apple] cannot revoke: APPLE_SIWA_KEY_ID / APPLE_SIWA_PRIVATE_KEY are not set.");
    return false;
  }
  const clientId = nativeClientId();
  const res = await fetch(`${APPLE_ISSUER}/auth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: appleClientSecret(clientId, key),
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });
  if (!res.ok) console.warn(`[apple] revoke failed (${res.status}).`);
  return res.ok;
}
