// Which local agent CLIs are installed. The desktop main process injects
// CLAUDE_BIN / CODEX_BIN (and an enriched PATH) when it finds the user's own
// installs; we never bundle the CLIs.
import { existsSync } from "node:fs";
import path from "node:path";
import { codexAvailable } from "./codex";

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return true;
  }
  return false;
}

export function claudeAvailable(): boolean {
  const bin = process.env.CLAUDE_BIN;
  if (bin && existsSync(bin)) return true;
  return onPath("claude");
}

export function availableEngines(): { claude: boolean; codex: boolean } {
  return { claude: claudeAvailable(), codex: codexAvailable() };
}
