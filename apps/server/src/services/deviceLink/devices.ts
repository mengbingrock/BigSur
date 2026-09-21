// Paired phones/tablets (link_devices). A device gets a bearer token at
// pairing time; it only authenticates once the user approves the device from
// the desktop (design §5.3). Tokens are stored hashed.
import crypto from "node:crypto";
import { getDb } from "../db";

const now = () => new Date().toISOString();

export interface DeviceRow {
  id: string;
  email: string;
  name: string;
  platform: string | null;
  pushToken: string | null;
  status: "pending" | "approved" | "revoked";
  code: string | null;
  createdAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
}

function rowToDevice(r: Record<string, unknown>): DeviceRow {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    platform: (r.platform as string | null) ?? null,
    pushToken: (r.push_token as string | null) ?? null,
    status: String(r.status) as DeviceRow["status"],
    code: (r.code as string | null) ?? null,
    createdAt: String(r.created_at),
    approvedAt: (r.approved_at as string | null) ?? null,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createDevice(opts: { email: string; name: string; platform?: string }): Promise<{ device: DeviceRow; token: string }> {
  const db = await getDb();
  const id = `dev_${crypto.randomBytes(9).toString("hex")}`;
  const token = `lbd_${crypto.randomBytes(24).toString("base64url")}`;
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare(
    "INSERT INTO link_devices (id, email, name, platform, token_hash, status, code, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run(id, opts.email, opts.name.slice(0, 64), opts.platform ?? null, hashToken(token), code, now());
  return { device: (await getDevice(id))!, token };
}

export async function getDevice(id: string): Promise<DeviceRow | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM link_devices WHERE id = ?").get(id);
  return row ? rowToDevice(row) : null;
}

export async function listDevices(email: string, status?: DeviceRow["status"]): Promise<DeviceRow[]> {
  const db = await getDb();
  const rows = status
    ? db.prepare("SELECT * FROM link_devices WHERE email = ? AND status = ? ORDER BY created_at DESC").all(email, status)
    : db.prepare("SELECT * FROM link_devices WHERE email = ? ORDER BY created_at DESC").all(email);
  return rows.map(rowToDevice);
}

export async function setDeviceStatus(email: string, id: string, status: DeviceRow["status"]): Promise<boolean> {
  const db = await getDb();
  const res = db
    .prepare("UPDATE link_devices SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END, code = NULL WHERE id = ? AND email = ?")
    .run(status, status, now(), id, email) as { changes?: number } | undefined;
  return Number(res?.changes ?? 0) > 0;
}

export async function setPushToken(email: string, id: string, pushToken: string | null): Promise<void> {
  const db = await getDb();
  db.prepare("UPDATE link_devices SET push_token = ? WHERE id = ? AND email = ?").run(pushToken, id, email);
}

/** Resolve a bearer token to its approved device (and touch last_seen). */
export async function authenticateDevice(token: string): Promise<DeviceRow | null> {
  if (!token.startsWith("lbd_")) return null;
  const db = await getDb();
  const row = db.prepare("SELECT * FROM link_devices WHERE token_hash = ? AND status = 'approved'").get(hashToken(token));
  if (!row) return null;
  db.prepare("UPDATE link_devices SET last_seen_at = ? WHERE id = ?").run(now(), String(row.id));
  return rowToDevice(row);
}

export async function pushTokensFor(email: string): Promise<string[]> {
  const db = await getDb();
  return db
    .prepare("SELECT push_token FROM link_devices WHERE email = ? AND status = 'approved' AND push_token IS NOT NULL")
    .all(email)
    .map((r) => String(r.push_token));
}
