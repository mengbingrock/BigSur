#!/usr/bin/env node
/* eslint-disable no-console */
// Backend user-management CLI for the Monterey chatbot.
//
// Usage:
//   node scripts/users.mjs list
//   node scripts/users.mjs create <email> [--admin]
//   node scripts/users.mjs delete <email>
//   node scripts/users.mjs reset-password <email>
//   node scripts/users.mjs promote <email>
//   node scripts/users.mjs demote <email>
//
// Reads/writes data/users.json (the same file the web app uses).

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import bcrypt from "bcryptjs";

const DATA_DIR = path.resolve("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

async function readUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    for (const u of users) {
      if (typeof u.isAdmin !== "boolean") u.isAdmin = false;
    }
    return { users };
  } catch (err) {
    if (err.code === "ENOENT") return { users: [] };
    throw err;
  }
}

async function writeUsers(file) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(tmp, USERS_FILE);
}

function normalize(email) {
  return String(email).trim().toLowerCase();
}

function validateEmail(email) {
  const e = normalize(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new Error(`Invalid email: ${email}`);
  }
  return e;
}

/** Read a password from stdin without echoing characters. Falls back to
 *  visible input if raw mode isn't available (e.g. piped stdin). */
function readHiddenPassword(promptText = "Password: ") {
  return new Promise((resolve) => {
    process.stdout.write(promptText);
    const stdin = process.stdin;
    const isTTY = stdin.isTTY;
    if (!isTTY) {
      // Non-interactive fallback — read one line.
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
          // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "" || ch === "") {
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

async function cmdList() {
  const { users } = await readUsers();
  if (users.length === 0) {
    console.log("(no users)");
    return;
  }
  const sorted = users
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const emailW = Math.max(5, ...sorted.map((u) => u.email.length));
  console.log(pad("EMAIL", emailW), " ", pad("ROLE", 6), " ", "CREATED");
  console.log("-".repeat(emailW), " ", "-".repeat(6), " ", "-".repeat(23));
  for (const u of sorted) {
    console.log(
      pad(u.email, emailW),
      " ",
      pad(u.isAdmin ? "admin" : "user", 6),
      " ",
      formatDate(u.createdAt),
    );
  }
  console.log(`\n${sorted.length} user(s).`);
}

async function cmdCreate(rawEmail, flags) {
  const email = validateEmail(rawEmail);
  const file = await readUsers();
  if (file.users.find((u) => u.email === email)) {
    throw new Error(`User ${email} already exists.`);
  }
  const password = await promptPasswordTwice();
  const isAdmin = flags.has("--admin") || file.users.length === 0;
  const passwordHash = await bcrypt.hash(password, 10);
  file.users.push({
    email,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString(),
  });
  await writeUsers(file);
  console.log(`Created ${email}${isAdmin ? " (admin)" : ""}.`);
}

async function cmdDelete(rawEmail) {
  const email = validateEmail(rawEmail);
  const file = await readUsers();
  const before = file.users.length;
  file.users = file.users.filter((u) => u.email !== email);
  if (file.users.length === before) throw new Error(`User ${email} not found.`);
  await writeUsers(file);
  console.log(`Deleted ${email}.`);
}

async function cmdResetPassword(rawEmail) {
  const email = validateEmail(rawEmail);
  const file = await readUsers();
  const user = file.users.find((u) => u.email === email);
  if (!user) throw new Error(`User ${email} not found.`);
  const password = await promptPasswordTwice();
  user.passwordHash = await bcrypt.hash(password, 10);
  await writeUsers(file);
  console.log(`Password reset for ${email}.`);
}

async function cmdSetAdmin(rawEmail, makeAdmin) {
  const email = validateEmail(rawEmail);
  const file = await readUsers();
  const user = file.users.find((u) => u.email === email);
  if (!user) throw new Error(`User ${email} not found.`);
  if (!makeAdmin) {
    const otherAdmins = file.users.filter(
      (u) => u.email !== email && u.isAdmin,
    ).length;
    if (otherAdmins === 0) {
      throw new Error(
        "Refusing to demote the last admin. Promote another user first.",
      );
    }
  }
  user.isAdmin = makeAdmin;
  await writeUsers(file);
  console.log(`${email} is now ${makeAdmin ? "an admin" : "a regular user"}.`);
}

function printUsage() {
  console.log(
    [
      "Monterey user management",
      "",
      "Commands:",
      "  list                         list all users",
      "  create <email> [--admin]     create a user (first user is auto-admin)",
      "  delete <email>               delete a user",
      "  reset-password <email>       prompt for a new password",
      "  promote <email>              make the user an admin",
      "  demote <email>               revoke admin",
      "",
      "Users are stored in data/users.json with bcrypt-hashed passwords.",
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
      await cmdList();
      break;
    case "create":
      if (!args[0]) throw new Error("Usage: create <email> [--admin]");
      await cmdCreate(args[0], flags);
      break;
    case "delete":
      if (!args[0]) throw new Error("Usage: delete <email>");
      await cmdDelete(args[0]);
      break;
    case "reset-password":
    case "reset":
      if (!args[0]) throw new Error("Usage: reset-password <email>");
      await cmdResetPassword(args[0]);
      break;
    case "promote":
      if (!args[0]) throw new Error("Usage: promote <email>");
      await cmdSetAdmin(args[0], true);
      break;
    case "demote":
      if (!args[0]) throw new Error("Usage: demote <email>");
      await cmdSetAdmin(args[0], false);
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
