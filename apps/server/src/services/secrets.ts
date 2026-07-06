// Symmetric encryption for per-user secrets (LLM API keys) stored at rest in
// SQLite. The key is derived from SESSION_PASSWORD so deployments already
// configure exactly one secret. AES-256-GCM; payloads are self-describing
// (v1:iv:tag:ciphertext, all base64).
import crypto from "node:crypto";

const SALT = "labee.secrets.v1";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const pw =
    process.env.SESSION_PASSWORD && process.env.SESSION_PASSWORD.length >= 32
      ? process.env.SESSION_PASSWORD
      : "dev-insecure-session-password-please-set-SESSION_PASSWORD-env-var";
  cachedKey = crypto.scryptSync(pw, SALT, 32);
  return cachedKey;
}

/** Encrypt a UTF-8 string. Returns a self-describing token, or null for empty. */
export function encryptSecret(plaintext: string): string | null {
  const value = plaintext.trim();
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** Decrypt a token produced by encryptSecret. Returns null on any failure. */
export function decryptSecret(token: string | null | undefined): string | null {
  if (!token) return null;
  const [version, ivB64, tagB64, ctB64] = token.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) return null;
  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}
