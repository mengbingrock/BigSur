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
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as net from "node:net";
import * as crypto from "node:crypto";

const isDev = process.env.ELECTRON_DEV === "1";
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5733";

// Keep in sync with apps/server session.ts (COOKIE_NAME, SESSION_TTL_SECONDS).
const SESSION_COOKIE = "monterey_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let serverBaseUrl = "";

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

/** Minimal KEY=VALUE parser for a dotenv-style file. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The "Desktop app" OAuth client credentials. Google issues a client secret
 *  even for installed-app clients, and the token endpoint requires it (PKCE is
 *  layered on top), so we pass both. Looked up from the environment, then a dev
 *  `apps/desktop/.env`, then a per-user `oauth.env` in userData (packaged). */
function googleDesktopCreds(): { id?: string; secret?: string } {
  const build = (id: string | undefined, secret: string | undefined) => {
    if (!id) return null;
    const creds: { id: string; secret?: string } = { id };
    if (secret) creds.secret = secret;
    return creds;
  };

  const fromEnv = build(
    process.env.GOOGLE_DESKTOP_CLIENT_ID,
    process.env.GOOGLE_DESKTOP_CLIENT_SECRET,
  );
  if (fromEnv) return fromEnv;

  const candidates = app.isPackaged
    ? [path.join(app.getPath("userData"), "oauth.env")]
    : [path.join(__dirname, "..", ".env"), path.join(app.getPath("userData"), "oauth.env")];
  for (const file of candidates) {
    const env = readEnvFile(file);
    const creds = build(env.GOOGLE_DESKTOP_CLIENT_ID, env.GOOGLE_DESKTOP_CLIENT_SECRET);
    if (creds) return creds;
  }
  return {};
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
  const env: NodeJS.ProcessEnv = {
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

  // Google sign-in: wire a "Desktop app" OAuth client (loopback + PKCE) to the
  // embedded server. Google allows any loopback port, so no redirect URI needs
  // registering. The client secret isn't confidential but is still required at
  // the token endpoint. If no client id is configured, the button stays hidden.
  const google = googleDesktopCreds();
  if (google.id) {
    env.GOOGLE_CLIENT_ID = google.id;
    env.GOOGLE_REDIRECT_URI = `http://${host}:${port}/api/auth/google/callback`;
    if (google.secret) env.GOOGLE_CLIENT_SECRET = google.secret;
    else delete env.GOOGLE_CLIENT_SECRET;
  }

  serverProcess = fork(entry, [], {
    cwd: path.dirname(entry),
    env,
    // node:sqlite (used by the DB adapter) is experimental in the bundled
    // Node 22, so it must be enabled with a flag.
    execArgv: ["--experimental-sqlite"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  serverProcess.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  serverProcess.on("message", (msg: unknown) => {
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === "labee:google-session"
    ) {
      void applyGoogleSession(msg as { value: string; next?: string });
    }
  });
  serverProcess.on("exit", (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });

  await waitForPort(port, host);
  serverBaseUrl = `http://${host}:${port}`;
  return serverBaseUrl;
}

/** Inject the sealed session (from the system-browser OAuth callback) into the
 *  window's cookie jar, then navigate the window to the post-login route. */
async function applyGoogleSession(msg: { value: string; next?: string }): Promise<void> {
  if (!mainWindow || !serverBaseUrl) return;
  const cookies = mainWindow.webContents.session.cookies;
  await cookies.set({
    url: serverBaseUrl,
    name: SESSION_COOKIE,
    value: msg.value,
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    expirationDate: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  // Programmatically-set cookies sit in a write buffer Electron only flushes on
  // a timer; force it to disk so the session survives an app restart.
  await cookies.flushStore();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const next = msg.next && msg.next.startsWith("/") ? msg.next : "/chat";
  await mainWindow.loadURL(serverBaseUrl + next);
}

/** True for URLs that must open in the system browser, not the app window:
 *  Google's consent pages and our own OAuth start route (which 302s to Google). */
function openAuthExternally(target: string): boolean {
  return (
    target.startsWith("https://accounts.google.com/") ||
    /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/api\/auth\/google(\?|$)/.test(target)
  );
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
    if (openAuthExternally(openUrl)) {
      void shell.openExternal(openUrl);
      return { action: "deny" };
    }
    if (openUrl.startsWith("http://localhost") || openUrl.startsWith("http://127.0.0.1")) {
      return { action: "allow" };
    }
    void shell.openExternal(openUrl);
    return { action: "deny" };
  });

  // Never let the Google OAuth flow load inside the app window — Google blocks
  // embedded webviews and the user expects their real browser (saved logins).
  // This catches both the preload-bridge path and any in-window navigation
  // (e.g. the web fallback that assigns window.location to the start route).
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (openAuthExternally(target)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  mainWindow.webContents.on("will-redirect", (event, target) => {
    if (target.startsWith("https://accounts.google.com/")) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  void mainWindow.loadURL(url);
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Renderer asks to start Google sign-in: open the OAuth flow in the system
// browser (Google blocks embedded webviews). The loopback callback hands the
// session back over IPC (see applyGoogleSession).
ipcMain.handle("labee:google-sign-in", (_event, next?: string) => {
  if (!serverBaseUrl) return;
  const target = next && next.startsWith("/") ? next : "/chat";
  void shell.openExternal(
    `${serverBaseUrl}/api/auth/google?next=${encodeURIComponent(target)}`,
  );
});

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
