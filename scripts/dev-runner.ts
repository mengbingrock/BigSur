// Dev orchestrator for the Labee monorepo. Spawns the right combination of
// the Effect server (Bun), the Vite web dev server, and Electron depending on
// the mode. Run via `node scripts/dev-runner.ts <mode>` (Node 24 runs TS).
//
//   dev          server + web
//   dev:server   server only
//   dev:web      web only (proxies /api to the server)
//   dev:desktop  server + web + electron
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PORT = Number(process.env.LABEE_PORT ?? 3000);
const WEB_PORT = Number(process.env.PORT ?? 5733);
const WEB_URL = `http://localhost:${WEB_PORT}`;

const mode = process.argv[2] ?? "dev";
const children: ChildProcess[] = [];

const COLORS: Record<string, string> = {
  server: "\x1b[36m",
  web: "\x1b[35m",
  electron: "\x1b[33m",
};
const RESET = "\x1b[0m";

function run(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `${COLORS[name] ?? ""}[${name}]${RESET} `;
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buf = "";
    stream.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        process.stdout.write(prefix + buf.slice(0, nl + 1));
        buf = buf.slice(nl + 1);
      }
    });
  };
  if (child.stdout) pipe(child.stdout);
  if (child.stderr) pipe(child.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function startServer() {
  run("server", "bun", ["run", "src/bin.ts"], path.join(ROOT, "apps/server"), {
    LABEE_PORT: String(SERVER_PORT),
    LABEE_HOST: "127.0.0.1",
  });
}

function startWeb() {
  run("web", "bun", ["run", "vite", "--port", String(WEB_PORT)], path.join(ROOT, "apps/web"), {
    PORT: String(WEB_PORT),
    LABEE_API_URL: `http://localhost:${SERVER_PORT}`,
  });
}

function startElectron() {
  run("electron", "bun", ["run", "electron", "."], path.join(ROOT, "apps/desktop"), {
    ELECTRON_DEV: "1",
    VITE_DEV_SERVER_URL: WEB_URL,
  });
}

let shuttingDown = false;
function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

switch (mode) {
  case "dev:server":
    startServer();
    break;
  case "dev:web":
    startWeb();
    break;
  case "dev:desktop":
    startServer();
    startWeb();
    // Give Vite a moment before Electron points a window at it.
    setTimeout(startElectron, 2500);
    break;
  case "dev":
  default:
    startServer();
    startWeb();
    break;
}
