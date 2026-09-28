#!/usr/bin/env node
/* eslint-disable no-console */
// Bring existing accounts down to the current signup allowance.
//
// The default grant changed from $20 to $5, which only affects accounts created
// afterwards. This caps the ones already provisioned — but never an account that
// paid: any top-up, subscription credit or manual adjustment in the ledger means
// the balance was not just the signup grant, and that account is left alone.
//
// Usage:
//   node scripts/cap-credits.mjs                 # dry run, prints what it would do
//   node scripts/cap-credits.mjs --apply         # make the change
//   node scripts/cap-credits.mjs --cap 500       # cap in cents (default 500)
//   node scripts/cap-credits.mjs --apply --force # include accounts that paid
//
// Operates on the same SQLite store the server uses. Override the location with
// LABEE_DB_PATH or LABEE_DATA_DIR.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.LABEE_DATA_DIR || process.env.MONTEREY_DATA_DIR || path.resolve("data");
const DB_PATH = process.env.LABEE_DB_PATH || path.join(DATA_DIR, "labee.sqlite");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");
const capArg = args.indexOf("--cap");
const CAP = capArg >= 0 ? Number.parseInt(args[capArg + 1] ?? "", 10) : 500;

if (!Number.isFinite(CAP) || CAP < 0) {
  console.error("--cap must be a non-negative number of cents");
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Set LABEE_DB_PATH or LABEE_DATA_DIR.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
// "Paid" = anything that added credit other than the one-time signup grant.
const PAID_KINDS = "('topup', 'subscription', 'adjustment')";
const rows = db
  .prepare(
    `SELECT b.email, b.credits, b.plan, b.subscription_status,
            (SELECT COUNT(*) FROM usage_events u
              WHERE u.email = b.email AND u.kind IN ${PAID_KINDS}) AS paid_rows
       FROM billing b
      WHERE b.credits > ?
      ORDER BY b.credits DESC`,
  )
  .all(CAP);

if (rows.length === 0) {
  console.log(`Nothing to do — no account holds more than ${CAP} cents.`);
  process.exit(0);
}

const dollars = (c) => `$${(c / 100).toFixed(2)}`;
let changed = 0;
let skipped = 0;
for (const r of rows) {
  const paid = Number(r.paid_rows) > 0 || (r.plan && r.plan !== "free");
  if (paid && !force) {
    console.log(`  skip   ${r.email.padEnd(34)} ${dollars(r.credits).padStart(9)}  (paid: plan=${r.plan}, ledger rows=${r.paid_rows})`);
    skipped += 1;
    continue;
  }
  console.log(`  ${apply ? "cap   " : "would "} ${r.email.padEnd(34)} ${dollars(r.credits).padStart(9)} → ${dollars(CAP)}`);
  if (apply) {
    const now = new Date().toISOString();
    db.prepare("UPDATE billing SET credits = ?, updated_at = ? WHERE email = ?").run(CAP, now, r.email);
    db.prepare(
      "INSERT INTO usage_events (email, kind, amount_cents, provider, model, created_at) VALUES (?, 'adjustment', ?, 'labee', 'credit-cap', ?)",
    ).run(r.email, CAP - r.credits, now);
    changed += 1;
  }
}

console.log(
  apply
    ? `\nCapped ${changed} account(s) at ${dollars(CAP)}${skipped ? `, left ${skipped} paid account(s) alone` : ""}.`
    : `\nDry run. ${rows.length - skipped} account(s) would be capped at ${dollars(CAP)}${skipped ? `, ${skipped} paid account(s) left alone` : ""}. Re-run with --apply.`,
);
db.close();
