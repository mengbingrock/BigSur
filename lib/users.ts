import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";

export interface User {
  email: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface PublicUser {
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

interface UsersFile {
  users: User[];
}

async function readFile(): Promise<UsersFile> {
  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    // Back-compat: old records may miss isAdmin.
    for (const u of users) {
      if (typeof u.isAdmin !== "boolean") u.isAdmin = false;
    }
    return { users };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
    throw err;
  }
}

async function writeFile(file: UsersFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(tmp, USERS_FILE);
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
  return {
    email: user.email,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
  };
}

export async function userCount(): Promise<number> {
  const { users } = await readFile();
  return users.length;
}

export async function findUser(email: string): Promise<User | null> {
  const e = normalizeEmail(email);
  const { users } = await readFile();
  return users.find((u) => u.email === e) ?? null;
}

export async function listUsers(): Promise<PublicUser[]> {
  const { users } = await readFile();
  return users
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toPublic);
}

export async function createUser(
  email: string,
  password: string,
  opts: { isAdmin?: boolean; autoPromoteFirst?: boolean } = {},
): Promise<User> {
  const e = validateEmailOrThrow(email);
  validatePasswordOrThrow(password);
  const file = await readFile();
  if (file.users.find((u) => u.email === e)) {
    throw new Error("An account with that email already exists.");
  }
  const isAdmin =
    opts.isAdmin === true ||
    (opts.autoPromoteFirst !== false && file.users.length === 0);
  const passwordHash = await bcrypt.hash(password, 10);
  const user: User = {
    email: e,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString(),
  };
  file.users.push(user);
  await writeFile(file);
  return user;
}

export async function deleteUser(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const file = await readFile();
  const before = file.users.length;
  file.users = file.users.filter((u) => u.email !== e);
  if (file.users.length === before) return false;
  await writeFile(file);
  return true;
}

export async function resetPassword(
  email: string,
  newPassword: string,
): Promise<boolean> {
  validatePasswordOrThrow(newPassword);
  const e = normalizeEmail(email);
  const file = await readFile();
  const user = file.users.find((u) => u.email === e);
  if (!user) return false;
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await writeFile(file);
  return true;
}

export async function setAdmin(
  email: string,
  isAdmin: boolean,
): Promise<boolean> {
  const e = normalizeEmail(email);
  const file = await readFile();
  const user = file.users.find((u) => u.email === e);
  if (!user) return false;
  if (!isAdmin) {
    const otherAdmins = file.users.filter(
      (u) => u.email !== e && u.isAdmin,
    ).length;
    if (otherAdmins === 0) {
      throw new Error(
        "Refusing to demote the last admin — promote another user first.",
      );
    }
  }
  user.isAdmin = isAdmin;
  await writeFile(file);
  return true;
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  const user = await findUser(email);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export function isSignupEnabled(): boolean {
  return process.env.SIGNUP_ENABLED !== "false";
}
