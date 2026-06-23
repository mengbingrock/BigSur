// Electron main process for the Labee desktop app (macOS + Windows).
//
// Labee is a full server app (API routes, session auth, file + SQLite
// storage), so we run the bundled @labee/server (a single ESM file that also
// serves the built web client) as a child process and point a BrowserWindow
// at it.
//
// Modes:
//   - dev  (ELECTRON_DEV=1): the dev-runner already serves Vite on :5733
//          (which proxies /api to the server); the window loads that and no
//          server is forked here.
//   - prod (default): fork the bundled server on a free port, wait for it,
//          then load it. Used for packaged apps and `electron .` on a build.
import { app, BrowserWindow, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";

const isDev = process.env.ELECTRON_DEV === "1";
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5733";

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 200);
        }
      });
    };
    tryOnce();
  });
}

/** Stable per-install SESSION_PASSWORD so login cookies survive restarts. */
function getOrCreateSessionSecret(): string {
  const file = path.join(app.getPath("userData"), "session-secret.txt");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Path to the bundled server entry. Packaged: resources/server/bin.mjs
 *  (with the web client beside it at resources/server/client). */
function serverEntry(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server", "bin.mjs")
    : path.join(__dirname, "..", "..", "server", "dist", "bin.mjs");
}

async function startServer(): Promise<string> {
  const port = await getFreePort();
  const host = "127.0.0.1";
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`Bundled server not found at ${entry}. Build @labee/server and @labee/web first.`);
  }

  const userData = app.getPath("userData");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    LABEE_MODE: "desktop",
    LABEE_PORT: String(port),
    LABEE_HOST: host,
    LABEE_DATA_DIR: path.join(userData, "data"),
    DECK_ROOT: path.join(userData, "labee-decks"),
    SESSION_PASSWORD: getOrCreateSessionSecret(),
    COOKIE_SECURE: "false",
  };

  serverProcess = fork(entry, [], {
    cwd: path.dirname(entry),
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  serverProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });

  await waitForPort(port, host);
  return `http://${host}:${port}`;
}

async function createWindow(): Promise<void> {
  const url = isDev ? DEV_URL : await startServer();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Labee",
    backgroundColor: "#fafaf7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith("http://localhost") || openUrl.startsWith("http://127.0.0.1")) {
      return { action: "allow" };
    }
    void shell.openExternal(openUrl);
    return { action: "deny" };
  });

  void mainWindow.loadURL(url);
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(createWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
process.on("exit", stopServer);
