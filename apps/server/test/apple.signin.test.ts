// Sign in with Apple (guideline 4.8): a real server verifies identity tokens
// against a stand-in for Apple's key endpoint, signed with keys made here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyTestEnv } from "./helpers/env";
import { freePort, startServer, type TestServer } from "./helpers/server";

const AUD = "online.labee.mobile";
const appleKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";

function idToken(
  claims: Record<string, unknown>,
  opts: { key?: crypto.KeyObject; kid?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: opts.kid ?? KID })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ iss: "https://appleid.apple.com", aud: AUD, iat: now, exp: now + 600, ...claims }),
  ).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), opts.key ?? appleKey.privateKey);
  return `${header}.${body}.${sig.toString("base64url")}`;
}

let server: TestServer;
let jwks: http.Server;
let dataDir: string;

beforeAll(async () => {
  applyTestEnv("apple");
  dataDir = process.env.LABEE_DATA_DIR!;
  const jwk = appleKey.publicKey.export({ format: "jwk" });
  const port = await freePort();
  jwks = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }));
  });
  await new Promise<void>((r) => jwks.listen(port, "127.0.0.1", r));
  server = await startServer({
    LABEE_DATA_DIR: dataDir,
    DECK_ROOT: process.env.DECK_ROOT!,
    SKILLS_ROOTS: process.env.SKILLS_ROOTS!,
    SESSION_PASSWORD: process.env.SESSION_PASSWORD!,
    CLAUDE_BIN: process.env.CLAUDE_BIN!,
    COOKIE_SECURE: "false",
    LABEE_MODE: "server",
    APPLE_JWKS_URL: `http://127.0.0.1:${port}/auth/keys`,
  });
}, 30000);

afterAll(() => {
  server?.stop();
  jwks?.close();
});

const signIn = (identityToken: string) =>
  fetch(`${server.base}/api/auth/apple`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken }),
  });

const appleIdOf = (email: string) => {
  const db = new DatabaseSync(path.join(dataDir, "labee.sqlite"), { readOnly: true });
  const row = db.prepare("SELECT apple_id FROM users WHERE email = ?").get(email) as { apple_id: string } | undefined;
  db.close();
  return row?.apple_id ?? null;
};

describe("POST /api/auth/apple", () => {
  it("creates an account from a private-relay address and returns a working session", async () => {
    const email = "abc123@privaterelay.appleid.com";
    const res = await signIn(idToken({ sub: "001.apple.one", email, email_verified: "true", is_private_email: "true" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; isAdmin: boolean; session: string };
    expect(body.email).toBe(email);
    // The hosted service never promotes a sign-up to admin.
    expect(body.isAdmin).toBe(false);
    expect(appleIdOf(email)).toBe("001.apple.one");

    // The mobile app sends the sealed session as a header.
    const me = await fetch(`${server.base}/api/me`, { headers: { "x-labee-session": body.session } });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);
  });

  it("finds the same account by Apple id when a later token carries no email", async () => {
    const res = await signIn(idToken({ sub: "001.apple.one" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe("abc123@privaterelay.appleid.com");
  });

  it("links to an existing account with the same email", async () => {
    const signup = await fetch(`${server.base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "both@example.com", password: "password-123" }),
    });
    expect(signup.status).toBe(200);
    const res = await signIn(idToken({ sub: "001.apple.two", email: "Both@Example.com", email_verified: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { email: string }).email).toBe("both@example.com");
    expect(appleIdOf("both@example.com")).toBe("001.apple.two");
  });

  it("refuses a first sign-in with no email to name the account by", async () => {
    const res = await signIn(idToken({ sub: "001.apple.nomail" }));
    expect(res.status).toBe(401);
  });

  it("refuses tokens that are forged, for another app, expired, or from the wrong issuer", async () => {
    const claims = { sub: "001.apple.bad", email: "bad@example.com" };
    const past = Math.floor(Date.now() / 1000) - 3600;
    const bad = [
      idToken(claims, { key: strangerKey.privateKey }),
      idToken(claims, { kid: "unknown-kid" }),
      idToken({ ...claims, aud: "com.example.other" }),
      idToken({ ...claims, exp: past }),
      idToken({ ...claims, iss: "https://evil.example" }),
      "not-a-jwt",
    ];
    for (const t of bad) expect((await signIn(t)).status).toBe(401);
    expect((await signIn("")).status).toBe(400);
    expect(appleIdOf("bad@example.com")).toBeNull();
  });
});

describe("appleClientSecret", () => {
  it("is an ES256 JWT Apple can verify with the key's public half", async () => {
    const { appleClientSecret } = await import("../src/services/apple");
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const jwt = appleClientSecret(AUD, { teamId: "TEAM123456", keyId: "KEY1234567", privateKey: pem });
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims).toMatchObject({ iss: "TEAM123456", sub: AUD, aud: "https://appleid.apple.com" });
    expect(
      crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")),
    ).toBe(true);
  });
});
