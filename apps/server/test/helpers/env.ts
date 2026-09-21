// Shared test environment: temp data/deck/skills dirs and the fake claude CLI.
// Must be applied BEFORE importing any server module (db.ts reads env at load).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_CLAUDE = path.resolve(here, "../fixtures/fake-claude.mjs");

export function applyTestEnv(name: string): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `labee-${name}-`));
  process.env.LABEE_DATA_DIR = path.join(root, "data");
  process.env.DECK_ROOT = path.join(root, "decks");
  process.env.SKILLS_ROOTS = path.join(root, "skills");
  fs.mkdirSync(process.env.SKILLS_ROOTS, { recursive: true });
  process.env.SESSION_PASSWORD ??= "test-password-at-least-32-chars-long!!";
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  delete process.env.LABEE_MODE;
  delete process.env.PROTOCOLS_MCP_URL;
  return { root };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}
