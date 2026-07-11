// Build a distributable Labee desktop artifact: compile web + server +
// electron, then run electron-builder. The packaged app ships the
// self-contained server bundle (apps/server/dist) + the built web client
// (apps/web/dist) as resources; no node_modules staging is needed.
//
//   node scripts/build-desktop-artifact.ts --platform mac --target dmg [--arch arm64]
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const platform = flag("platform", process.platform === "win32" ? "win" : process.platform === "linux" ? "linux" : "mac")!;
const target = flag("target");
const arch = flag("arch");

const platformFlag = platform === "mac" ? "--mac" : platform === "win" ? "--win" : "--linux";

function step(
  label: string,
  command: string,
  args: string[],
  cwd = ROOT,
  env: NodeJS.ProcessEnv = process.env,
) {
  console.log(`\n[artifact] ${label}: ${command} ${args.join(" ")}`);
  const res = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (res.status !== 0) {
    console.error(`[artifact] step failed: ${label}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Build the workspaces the desktop bundle depends on. The protocol-search MCP
//    server ships as an extraResource, but it's now the published npm package
//    (@mengbingrock/labee-protocol-searcher) resolved from node_modules — no
//    build step needed for it.
step(
  "build web/server/desktop",
  "bun",
  [
    "run", "turbo", "run", "build",
    "--filter=@labee/web",
    "--filter=@labee/server",
    "--filter=@labee/desktop",
  ],
);

// 2. Package with electron-builder. Run the local bin directly (not via `bun x`)
// and strip npm_* env vars: under bun, npm_execpath points at the bun *binary*,
// and electron-builder runs `node $npm_execpath` to drive the package manager —
// which fails because the bun binary isn't a JS file.
const builderArgs = [platformFlag];
if (target) builderArgs.push(`${platformFlag === "--mac" ? "--config.mac.target" : platformFlag === "--win" ? "--config.win.target" : "--config.linux.target"}`, target);
if (arch) builderArgs.push(`--${arch}`);
const builderBin = path.join(ROOT, "node_modules", ".bin", "electron-builder");
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv.npm_execpath;
delete cleanEnv.npm_config_user_agent;
step("electron-builder", builderBin, builderArgs, path.join(ROOT, "apps/desktop"), cleanEnv);

console.log("\n[artifact] Done. See apps/desktop/release/");
