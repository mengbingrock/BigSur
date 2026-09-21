// Per-process secret that lets the desktop's own Device Link client mark the
// requests it replays from the box as authenticated for the linked account.
import crypto from "node:crypto";

let secret: string | null = null;

export function linkSecret(): string | null {
  return secret;
}

export function ensureLinkSecret(): string {
  if (!secret) secret = crypto.randomBytes(24).toString("base64url");
  return secret;
}
