#!/usr/bin/env node
/* eslint-disable no-console */
// Backend user-management CLI for Labee.
//
// Usage:
//   node scripts/users.mjs list
//   node scripts/users.mjs create <email> [--admin]
//   node scripts/users.mjs delete <email>
//   node scripts/users.mjs reset-password <email>
//   node scripts/users.mjs promote <email>
//   node scripts/users.mjs demote <email>
//
// Operates on the same SQLite store the server uses (node:sqlite, no native
// deps). Override the location with LABEE_DB_PATH or LABEE_DATA_DIR.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";

const DATA_DIR =
  process.env.LABEE_DATA_DIR || process.env.MONTEREY_DATA_DIR || path.resolve("data");
const DB_PATH = process.env.LABEE_DB_PATH || path.join(DATA_DIR, "labee.sqlite");

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(
    "CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, " +
      "is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);",
  );
  return db;
}

const db = openDb();

function listUsers() {
  return db
    .prepare("SELECT email, is_admin, created_at FROM users ORDER BY created_at ASC")
    .all()
    .map((r) => ({ email: r.email, isAdmin: Number(r.is_admin) === 1, createdAt: r.created_at }));
}
const userExists = (email) => Boolean(db.prepare("SELECT 1 FROM users WHERE email = ?").get(email));
const otherAdmins = (email) =>
  Number(
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE email != ? AND is_admin = 1").get(email).n,
  );

function normalize(email) {
  return String(email).trim().toLowerCase();
}

function validateEmail(email) {
  const e = normalize(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error(`Invalid email: ${email}`);
  return e;
}

function readHiddenPassword(promptText = "Password: ") {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question("", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        } else if (ch === "") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "" || ch === "\b") {
          if (value.length > 0) value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function promptPasswordTwice() {
  const pw1 = await readHiddenPassword("New password: ");
  if (pw1.length < 8) throw new Error("Password must be at least 8 characters.");
  const pw2 = await readHiddenPassword("Confirm password: ");
  if (pw1 !== pw2) throw new Error("Passwords do not match.");
  return pw1;
}

function formatDate(iso) {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function cmdList() {
  const users = listUsers();
  if (users.length === 0) {
    console.log("(no users)");
    return;
  }
  const emailW = Math.max(5, ...users.map((u) => u.email.length));
  console.log(pad("EMAIL", emailW), " ", pad("ROLE", 6), " ", "CREATED");
  console.log("-".repeat(emailW), " ", "-".repeat(6), " ", "-".repeat(23));
  for (const u of users) {
    console.log(pad(u.email, emailW), " ", pad(u.isAdmin ? "admin" : "user", 6), " ", formatDate(u.createdAt));
  }
  console.log(`\n${users.length} user(s).`);
}

async function cmdCreate(rawEmail, flags) {
  const email = validateEmail(rawEmail);
  if (userExists(email)) throw new Error(`User ${email} already exists.`);
  const password = await promptPasswordTwice();
  const isAdmin = flags.has("--admin") || listUsers().length === 0;
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    "INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
  ).run(email, passwordHash, isAdmin ? 1 : 0, new Date().toISOString());
  console.log(`Created ${email}${isAdmin ? " (admin)" : ""}.`);
}

function cmdDelete(rawEmail) {
  const email = validateEmail(rawEmail);
  if (!userExists(email)) throw new Error(`User ${email} not found.`);
  db.prepare("DELETE FROM users WHERE email = ?").run(email);
  console.log(`Deleted ${email}.`);
}

async function cmdResetPassword(rawEmail) {
  const email = validateEmail(rawEmail);
  if (!userExists(email)) throw new Error(`User ${email} not found.`);
  const password = await promptPasswordTwice();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(passwordHash, email);
  console.log(`Password reset for ${email}.`);
}

function cmdSetAdmin(rawEmail, makeAdmin) {
  const email = validateEmail(rawEmail);
  if (!userExists(email)) throw new Error(`User ${email} not found.`);
  if (!makeAdmin && otherAdmins(email) === 0) {
    throw new Error("Refusing to demote the last admin. Promote another user first.");
  }
  db.prepare("UPDATE users SET is_admin = ? WHERE email = ?").run(makeAdmin ? 1 : 0, email);
  console.log(`${email} is now ${makeAdmin ? "an admin" : "a regular user"}.`);
}

function printUsage() {
  console.log(
    [
      "Labee user management",
      "",
      "Commands:",
      "  list                         list all users",
      "  create <email> [--admin]     create a user (first user is auto-admin)",
      "  delete <email>               delete a user",
      "  reset-password <email>       prompt for a new password",
      "  promote <email>              make the user an admin",
      "  demote <email>               revoke admin",
      "",
      `Users are stored in ${DB_PATH} with bcrypt-hashed passwords.`,
    ].join("\n"),
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = rest.filter((a) => !a.startsWith("--"));
  const flags = new Set(rest.filter((a) => a.startsWith("--")));

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  switch (cmd) {
    case "list":
      cmdList();
      break;
    case "create":
      if (!args[0]) throw new Error("Usage: create <email> [--admin]");
      await cmdCreate(args[0], flags);
      break;
    case "delete":
      if (!args[0]) throw new Error("Usage: delete <email>");
      cmdDelete(args[0]);
      break;
    case "reset-password":
    case "reset":
      if (!args[0]) throw new Error("Usage: reset-password <email>");
      await cmdResetPassword(args[0]);
      break;
    case "promote":
      if (!args[0]) throw new Error("Usage: promote <email>");
      cmdSetAdmin(args[0], true);
      break;
    case "demote":
      if (!args[0]) throw new Error("Usage: demote <email>");
      cmdSetAdmin(args[0], false);
      break;
    default:
      printUsage();
      throw new Error(`Unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  console.error("error:", err.message || err);
  process.exit(1);
});
