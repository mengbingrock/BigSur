import bcrypt from "bcryptjs";
import { getDb, type SqlStatement } from "./db";

export interface User {
  email: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
  googleId: string | null;
}

export interface PublicUser {
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

function rowToUser(r: Record<string, unknown>): User {
  return {
    email: String(r.email),
    passwordHash: String(r.password_hash),
    isAdmin: Number(r.is_admin) === 1,
    createdAt: String(r.created_at),
    googleId: r.google_id == null ? null : String(r.google_id),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateEmailOrThrow(email: string): string {
  const e = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error("Please enter a valid email address.");
  }
  return e;
}

function validatePasswordOrThrow(password: string): void {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
}

export function toPublic(user: User): PublicUser {
  return { email: user.email, isAdmin: user.isAdmin, createdAt: user.createdAt };
}

async function stmt(sql: string): Promise<SqlStatement> {
  const db = await getDb();
  return db.prepare(sql);
}

export async function userCount(): Promise<number> {
  const row = (await stmt("SELECT COUNT(*) AS n FROM users")).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export async function findUser(email: string): Promise<User | null> {
  const row = (await stmt("SELECT * FROM users WHERE email = ?")).get(normalizeEmail(email));
  return row ? rowToUser(row) : null;
}

export async function listUsers(): Promise<PublicUser[]> {
  const rows = (await stmt("SELECT * FROM users ORDER BY created_at ASC")).all();
  return rows.map(rowToUser).map(toPublic);
}

export async function createUser(
  email: string,
  password: string,
  opts: { isAdmin?: boolean; autoPromoteFirst?: boolean } = {},
): Promise<User> {
  const e = validateEmailOrThrow(email);
  validatePasswordOrThrow(password);
  if ((await stmt("SELECT 1 FROM users WHERE email = ?")).get(e)) {
    throw new Error("An account with that email already exists.");
  }
  const isAdmin = opts.isAdmin === true || (opts.autoPromoteFirst !== false && (await userCount()) === 0);
  const passwordHash = await bcrypt.hash(password, 10);
  const createdAt = new Date().toISOString();
  (await stmt(
    "INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
  )).run(e, passwordHash, isAdmin ? 1 : 0, createdAt);
  return { email: e, passwordHash, isAdmin, createdAt, googleId: null };
}

export async function findUserByGoogleId(googleId: string): Promise<User | null> {
  const row = (await stmt("SELECT * FROM users WHERE google_id = ?")).get(googleId);
  return row ? rowToUser(row) : null;
}

/** Sign in (or register) a user via verified Google identity. Accounts are
 *  linked by email: an existing password account with the same email gains the
 *  Google link; otherwise a new, password-less account is created. The first
 *  account on a fresh instance is promoted to admin, matching password signup. */
export async function upsertGoogleUser(profile: {
  googleId: string;
  email: string;
}): Promise<User> {
  const e = validateEmailOrThrow(profile.email);
  const googleId = profile.googleId.trim();
  if (!googleId) throw new Error("Missing Google account id.");

  const existing = await findUser(e);
  if (existing) {
    // Link the Google id on first Google sign-in for this email (idempotent).
    if (existing.googleId !== googleId) {
      (await stmt("UPDATE users SET google_id = ? WHERE email = ?")).run(googleId, e);
    }
    return { ...existing, googleId };
  }

  // New Google-only account: store an empty password hash so password login is
  // impossible (bcrypt.compare against "" never succeeds).
  const isAdmin = (await userCount()) === 0;
  const createdAt = new Date().toISOString();
  (await stmt(
    "INSERT INTO users (email, password_hash, is_admin, created_at, google_id) VALUES (?, ?, ?, ?, ?)",
  )).run(e, "", isAdmin ? 1 : 0, createdAt, googleId);
  return { email: e, passwordHash: "", isAdmin, createdAt, googleId };
}

export async function deleteUser(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!(await stmt("SELECT 1 FROM users WHERE email = ?")).get(e)) return false;
  (await stmt("DELETE FROM users WHERE email = ?")).run(e);
  return true;
}

export async function resetPassword(email: string, newPassword: string): Promise<boolean> {
  validatePasswordOrThrow(newPassword);
  const e = normalizeEmail(email);
  if (!(await stmt("SELECT 1 FROM users WHERE email = ?")).get(e)) return false;
  const hash = await bcrypt.hash(newPassword, 10);
  (await stmt("UPDATE users SET password_hash = ? WHERE email = ?")).run(hash, e);
  return true;
}

export async function setAdmin(email: string, isAdmin: boolean): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!(await stmt("SELECT 1 FROM users WHERE email = ?")).get(e)) return false;
  if (!isAdmin) {
    const others = (await stmt(
      "SELECT COUNT(*) AS n FROM users WHERE email != ? AND is_admin = 1",
    )).get(e) as { n: number } | undefined;
    if (Number(others?.n ?? 0) === 0) {
      throw new Error("Refusing to demote the last admin — promote another user first.");
    }
  }
  (await stmt("UPDATE users SET is_admin = ? WHERE email = ?")).run(isAdmin ? 1 : 0, e);
  return true;
}

export async function verifyCredentials(email: string, password: string): Promise<User | null> {
  const user = await findUser(email);
  if (!user) return null;
  // Google-only accounts carry an empty hash and cannot be reached by password.
  if (!user.passwordHash) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export function isSignupEnabled(): boolean {
  return process.env.SIGNUP_ENABLED !== "false";
}
