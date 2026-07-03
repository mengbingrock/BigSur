// Electron main process for the Labee desktop app (macOS + Windows).
//
// Labee is a full server app (API routes, session auth, file + SQLite
// storage), so we run the bundled @labee/server (a single ESM file that also
// serves the built web client) as a child process and point a BrowserWindow
// at it.
//
// Modes:
//   - dev    (ELECTRON_DEV=1): the dev-runner already serves Vite on :5733
//            (which proxies /api to the server); the window loads that and no
//            server is forked here.
//   - embedded (default for packaged builds): fork the bundled server on a free
//            port and load it. The agent runs locally on the user's machine,
//            using their own installed claude/codex CLI. Self-contained local
//            SQLite/file storage. Google sign-in uses the loopback flow.
//   - remote (LABEE_REMOTE=1): load a hosted server directly (LABEE_REMOTE_URL,
//            default https://labee.online); all data/billing live on the host.
//            Google sign-in runs in-window under a Chrome UA.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";

const isDev = process.env.ELECTRON_DEV === "1";
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5733";
// The desktop app runs the bundled local server by default, so the agent runs
// on the user's machine against local folders. Opt into a hosted server with
// LABEE_REMOTE=1 (target via LABEE_REMOTE_URL).
const REMOTE_URL = (process.env.LABEE_REMOTE_URL ?? "https://labee.online").replace(/\/+$/, "");
const useRemote = !isDev && process.env.LABEE_REMOTE === "1";
const useEmbedded = !isDev && !useRemote;

// Keep in sync with apps/server session.ts (COOKIE_NAME, SESSION_TTL_SECONDS).
const SESSION_COOKIE = "monterey_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let serverBaseUrl = "";
// Remote-mode Google sign-in: a one-shot loopback listener the hosted server
// redirects the session back to.
let googleLoopback: http.Server | null = null;

const GOOGLE_DONE_HTML = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#1c1c1c;background:#fafaf7}div{text-align:center}</style>
<div><h1>You're signed in to Labee</h1><p>You can close this tab and return to the app.</p></div>`;

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

/** Read a single desktop config value from the environment, then the dev
 *  `apps/desktop/.env` / packaged `<userData>/labee.env`. */
function desktopEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const files = app.isPackaged
    ? [path.join(app.getPath("userData"), "labee.env")]
    : [path.join(__dirname, "..", ".env"), path.join(app.getPath("userData"), "labee.env")];
  for (const f of files) {
    const v = readEnvFile(f)[key];
    if (v) return v;
  }
  return undefined;
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

/** Config the embedded server / protocol-search MCP reads: web-search provider
 *  keys (Brave/Google) so vendor search returns results, plus other PROTOCOLS_*
 *  tuning. Sourced from the process env, then `apps/desktop/.env` (dev) / a
 *  per-user `labee.env` in userData (packaged). Absent keys are simply omitted. */
function desktopSearchEnv(): Record<string, string> {
  const KEYS = [
    "BRAVE_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CSE_KEY",
    "GOOGLE_CSE_CX",
    "PROTOCOLS_SEARCH_PROVIDER",
    "PROTOCOLS_JOURNAL_PROVIDERS",
    "PROTOCOLS_CONTACT_EMAIL",
    "SEMANTIC_SCHOLAR_API_KEY",
    "NCBI_API_KEY",
    // Stripe billing (the purchase plan shown for Labee-provided access).
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_SUBSCRIPTION_PRICES",
    "STRIPE_SUBSCRIPTION_PRICES_MAX",
    "STRIPE_CREDIT_PRICES",
  ];
  const files = app.isPackaged
    ? [path.join(app.getPath("userData"), "labee.env")]
    : [path.join(__dirname, "..", ".env"), path.join(app.getPath("userData"), "labee.env")];
  const merged: Record<string, string> = {};
  for (const file of files) Object.assign(merged, readEnvFile(file));
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = process.env[k] ?? merged[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Path to the bundled server entry. Packaged: resources/server/bin.mjs
 *  (with the web client beside it at resources/server/client). */
function serverEntry(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server", "bin.mjs")
    : path.join(__dirname, "..", "..", "server", "dist", "bin.mjs");
}

let cachedUserPath: string | null = null;

/** The user's *real* PATH. A GUI app launched from Finder/Dock inherits a
 *  minimal PATH (/usr/bin:/bin:…), so CLIs installed in ~/.local/bin, Homebrew,
 *  nvm, bun, etc. aren't found. We resolve the login shell's PATH and merge the
 *  usual install dirs. We never bundle the agent CLIs — we locate the user's
 *  own install. */
function resolveUserPath(): string {
  if (cachedUserPath) return cachedUserPath;
  const parts: string[] = [];

  // 1) Ask the login shell for its PATH (captures brew, nvm, asdf, pyenv, …).
  if (process.platform !== "win32") {
    const shell = process.env.SHELL || "/bin/zsh";
    try {
      const out = execFileSync(shell, ["-ilc", 'printf "%s" "$PATH"'], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // A noisy .zshrc may print before our value; keep only PATH-looking parts.
      for (const seg of out.split(/[\n:]/)) {
        if (seg.startsWith("/")) parts.push(seg.trim());
      }
    } catch {
      /* shell probe failed — the common dirs below still cover most installs */
    }
  }

  // 2) Common locations the shell probe might miss.
  const home = os.homedir();
  if (process.platform !== "win32") {
    parts.push(
      path.join(home, ".local/bin"),
      path.join(home, ".bun/bin"),
      path.join(home, ".npm-global/bin"),
      path.join(home, ".deno/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    );
  }

  // 3) Whatever PATH this process already has.
  if (process.env.PATH) parts.push(...process.env.PATH.split(path.delimiter));

  const seen = new Set<string>();
  cachedUserPath = parts
    .filter((p) => p && !seen.has(p) && seen.add(p))
    .join(path.delimiter);
  return cachedUserPath;
}

/** Locate an executable by name across `searchPath` (absolute path, or null).
 *  Never bundles — finds the user's own install of claude/codex. */
function findBinary(name: string, searchPath: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not executable / not here */
      }
    }
  }
  return null;
}

async function startServer(): Promise<string> {
  // A fixed port (LABEE_DESKTOP_PORT, from env or apps/desktop/.env) gives a
  // stable loopback URL — handy for pointing a local Stripe webhook listener at
  // the embedded server. Otherwise pick any free port.
  const preferred = Number(desktopEnvValue("LABEE_DESKTOP_PORT"));
  const port = Number.isInteger(preferred) && preferred > 0 ? preferred : await getFreePort();
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

  // Point the server at the bundled protocol-search MCP (shipped as an
  // extraResource beside the server bundle). Only relevant to the embedded
  // server; remote mode uses the hosted server's own copy.
  if (app.isPackaged) {
    env.PROTOCOLS_MCP_PATH = path.join(process.resourcesPath, "mcp-protocols", "dist", "index.mjs");
  }

  // Local-first: let the embedded server pull the user's agents/skills FROM the
  // hosted Labee server, authenticating with a box session the desktop persists
  // at "Connect to Labee" (see labee:connect-labee / connectToLabee()).
  env.LABEE_SKILLS_SERVER = process.env.LABEE_SKILLS_SERVER ?? REMOTE_URL;
  env.LABEE_REMOTE_SESSION_FILE = remoteSessionFile();

  // Web-search provider keys (Brave/Google) for the protocol-search MCP, so local
  // reagent-vendor search returns results instead of being bot-blocked.
  Object.assign(env, desktopSearchEnv());

  // The agent runs locally: the server spawns the user's own claude/codex CLI.
  // Give it the real user PATH (Finder-launched apps get a stripped one) and the
  // resolved absolute binary paths so spawns work regardless of how the app was
  // started. We never bundle these CLIs.
  const userPath = resolveUserPath();
  env.PATH = userPath;
  const claudeBin = findBinary("claude", userPath);
  const codexBin = findBinary("codex", userPath);
  if (claudeBin) env.CLAUDE_BIN = claudeBin;
  if (codexBin) env.CODEX_BIN = codexBin;
  console.log(
    `[labee] agent CLIs — claude: ${claudeBin ?? "not found"}, codex: ${codexBin ?? "not found"}`,
  );

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
    // Must match the origin: the hosted server is https, the embedded one http.
    secure: serverBaseUrl.startsWith("https"),
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
 *  Google's consent pages and our own OAuth start route (which 302s to Google).
 *  Only relevant in embedded mode, where Google sign-in uses the loopback flow. */
function openAuthExternally(target: string): boolean {
  return (
    target.startsWith("https://accounts.google.com/") ||
    /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/api\/auth\/google(\?|$)/.test(target)
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function isLoopback(u: string): boolean {
  return u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1");
}

/** A Chrome-like UA with the Electron/app tokens stripped, so the hosted site's
 *  Google OAuth (which refuses to load in "Electron") runs in-window. */
function chromeUserAgent(): string {
  return app.userAgentFallback
    .replace(/ Electron\/[\d.]+/g, "")
    .replace(/ Labee\/[\d.]+/g, "");
}

async function createWindow(): Promise<void> {
  let url: string;
  if (isDev) {
    url = DEV_URL;
    // So the Google loopback's applyGoogleSession can set the cookie + navigate.
    serverBaseUrl = DEV_URL;
  } else if (useRemote) {
    serverBaseUrl = REMOTE_URL;
    url = REMOTE_URL;
  } else {
    url = await startServer();
  }

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

  // Remote mode: present as a normal browser (some sites — and any embedded
  // third-party content — refuse to load under an "Electron" user agent).
  if (useRemote) mainWindow.webContents.setUserAgent(chromeUserAgent());

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    // Embedded loopback Google flow must open in the system browser.
    if (!useRemote && openAuthExternally(openUrl)) {
      void shell.openExternal(openUrl);
      return { action: "deny" };
    }
    // Keep same-origin (and dev/embedded loopback) navigations in the app window.
    if (sameOrigin(openUrl, serverBaseUrl) || (!useRemote && isLoopback(openUrl))) {
      return { action: "allow" };
    }
    void shell.openExternal(openUrl);
    return { action: "deny" };
  });

  // In embedded mode Google sign-in uses the system browser (Google blocks
  // embedded webviews); intercept any in-window attempt to reach it. In remote
  // mode the flow runs in-window under a Chrome UA, so don't intercept.
  if (!useRemote) {
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
  }

  console.log(
    `[labee] loading ${url} (${isDev ? "dev" : useRemote ? "remote" : "embedded"})`,
  );
  void mainWindow.loadURL(url);
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Open Google sign-in in the system browser (so the user's saved Google accounts
 *  are available) against `base`, with a one-shot loopback listener that `base`
 *  redirects the sealed session back to. Used for remote mode (labee.online) and
 *  for dev (the Vite origin, which proxies /api to the local server). */
function startGoogleSignInRemote(base: string, next: string): void {
  if (googleLoopback) {
    try {
      googleLoopback.close();
    } catch {
      /* already closed */
    }
    googleLoopback = null;
  }
  const server = http.createServer((req, res) => {
    let value: string | null = null;
    let nx = next;
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!u.pathname.startsWith("/cb")) {
        res.writeHead(404);
        res.end();
        return;
      }
      value = u.searchParams.get("session");
      nx = u.searchParams.get("next") || next;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(GOOGLE_DONE_HTML);
    } finally {
      server.close();
      if (googleLoopback === server) googleLoopback = null;
    }
    if (value) void applyGoogleSession({ value, next: nx });
  });
  googleLoopback = server;
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const cb = `http://127.0.0.1:${port}/cb`;
    void shell.openExternal(
      `${base}/api/auth/google?next=${encodeURIComponent(next)}&desktop=${encodeURIComponent(cb)}`,
    );
  });
  // Auto-close if the user never finishes the flow.
  setTimeout(
    () => {
      if (googleLoopback === server) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
        googleLoopback = null;
      }
    },
    5 * 60 * 1000,
  );
}

// Renderer asks to start Google sign-in: always open the system browser (so
// saved Google accounts are available). The session is relayed back to the
// window — via a loopback listener in remote mode, or server IPC in embedded.
ipcMain.handle("labee:google-sign-in", (_event, next?: string) => {
  const target = next && next.startsWith("/") ? next : "/chat";
  // Remote (labee.online) and dev (the Vite origin) both use the loopback flow;
  // dev's local server isn't forked with an IPC channel, so the loopback is how
  // the sealed session gets back to the window.
  if (useRemote) {
    startGoogleSignInRemote(REMOTE_URL, target);
    return;
  }
  if (isDev) {
    startGoogleSignInRemote(DEV_URL, target);
    return;
  }
  if (!serverBaseUrl) return;
  void shell.openExternal(`${serverBaseUrl}/api/auth/google?next=${encodeURIComponent(target)}`);
});

/** File holding the hosted-Labee (box) session used to sync agents/skills. */
function remoteSessionFile(): string {
  return path.join(app.getPath("userData"), "remote-session.txt");
}

let connectLoopback: http.Server | null = null;

/** Local-first: capture a labee.online (box) session so the embedded server can
 *  pull the user's agents/skills. Opens the hosted Google sign-in in the system
 *  browser with a one-shot loopback the box redirects the sealed session to,
 *  then persists it (0600) to remoteSessionFile(). Resolves true once captured. */
function connectToLabee(): Promise<boolean> {
  if (connectLoopback) {
    try {
      connectLoopback.close();
    } catch {
      /* already closed */
    }
    connectLoopback = null;
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const server = http.createServer((req, res) => {
      let value: string | null = null;
      try {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!u.pathname.startsWith("/cb")) {
          res.writeHead(404);
          res.end();
          return;
        }
        value = u.searchParams.get("session");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(GOOGLE_DONE_HTML);
      } finally {
        server.close();
        if (connectLoopback === server) connectLoopback = null;
      }
      if (value) {
        try {
          const file = remoteSessionFile();
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, value, { mode: 0o600 });
          finish(true);
        } catch {
          finish(false);
        }
      } else {
        finish(false);
      }
    });
    connectLoopback = server;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const cb = `http://127.0.0.1:${port}/cb`;
      void shell.openExternal(
        `${REMOTE_URL}/api/auth/google?next=${encodeURIComponent("/")}&desktop=${encodeURIComponent(cb)}`,
      );
    });
    setTimeout(
      () => {
        if (connectLoopback === server) {
          try {
            server.close();
          } catch {
            /* already closed */
          }
          connectLoopback = null;
        }
        finish(false);
      },
      5 * 60 * 1000,
    );
  });
}

// Renderer asks to connect the user's hosted Labee account (for agent/skill sync).
ipcMain.handle("labee:connect-labee", () => connectToLabee());

// Renderer asks for a native folder picker (used to choose the agent's working
// directory / reference folders). Returns the absolute path, or null.
ipcMain.handle("labee:pick-folder", async (_event, defaultPath?: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder",
    buttonLabel: "Use folder",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
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
  if (googleLoopback) {
    try {
      googleLoopback.close();
    } catch {
      /* already closed */
    }
    googleLoopback = null;
  }
}
app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
process.on("exit", stopServer);
