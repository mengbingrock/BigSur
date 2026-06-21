// Electron main process for the Monterey desktop app (Windows + macOS).
//
// Monterey is a full Next.js *server* app (API routes, session auth, file
// storage), so we can't just load static files. Instead we run the Next.js
// standalone server (`.next/standalone/server.js`) as a child process and
// point a BrowserWindow at it.
//
// Modes:
//   - dev   (ELECTRON_DEV=1): assumes `next dev` is already serving :3000;
//            the window loads http://localhost:3000 and no server is forked.
//   - prod  (default): fork the bundled standalone server on a free port,
//            wait for it, then load it. Used both for packaged apps and for
//            `electron .` against a local build.

const { app, BrowserWindow, shell } = require("electron");
const { fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const isDev = process.env.ELECTRON_DEV === "1";

let serverProcess = null;
let mainWindow = null;

/** Find a free TCP port on the loopback interface. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll until the server accepts a TCP connection (or time out). */
function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
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

/**
 * A stable per-install secret for SESSION_PASSWORD, generated once and kept
 * in userData so sessions survive restarts. (Without a stable secret every
 * launch would invalidate the login cookie.)
 */
function getOrCreateSessionSecret() {
  const file = path.join(app.getPath("userData"), "session-secret.txt");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const secret = crypto.randomBytes(32).toString("hex"); // 64 chars
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Absolute path to the bundled standalone server directory. */
function standaloneDir() {
  // Packaged: extraResources copies .next/standalone -> resources/standalone.
  // Unpackaged (electron . against a local build): use the project's build.
  return app.isPackaged
    ? path.join(process.resourcesPath, "standalone")
    : path.join(__dirname, "..", ".next", "standalone");
}

/** Fork the Next.js standalone server and resolve with its base URL. */
async function startServer() {
  const port = await getFreePort();
  const host = "127.0.0.1";
  const dir = standaloneDir();
  const serverJs = path.join(dir, "server.js");

  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Standalone server not found at ${serverJs}. Run "npm run build && npm run electron:prepare" first.`,
    );
  }

  const userData = app.getPath("userData");
  const env = {
    ...process.env,
    // Make the child run as plain Node using Electron's bundled runtime.
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: host,
    // Redirect all writable storage into the OS per-user data dir, since the
    // app bundle is read-only.
    MONTEREY_DATA_DIR: path.join(userData, "data"),
    DECK_ROOT: path.join(userData, "monterey-decks"),
    SESSION_PASSWORD: getOrCreateSessionSecret(),
    // Desktop app is served over plain http on loopback, so don't require a
    // Secure cookie (which browsers drop on non-https).
    COOKIE_SECURE: "false",
  };

  serverProcess = fork(serverJs, [], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  serverProcess.stdout?.on("data", (d) => process.stdout.write(`[next] ${d}`));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(`[next] ${d}`));
  serverProcess.on("exit", (code) => {
    console.log(`[next] server exited with code ${code}`);
    serverProcess = null;
  });

  await waitForPort(port, host);
  return `http://${host}:${port}`;
}

async function createWindow() {
  const url = isDev ? "http://localhost:3000" : await startServer();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Labee",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the system browser, not new
  // Electron windows.
  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith("http://localhost") || openUrl.startsWith("http://127.0.0.1")) {
      return { action: "allow" };
    }
    shell.openExternal(openUrl);
    return { action: "deny" };
  });

  mainWindow.loadURL(url);
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Single-instance lock so a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}
app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
process.on("exit", stopServer);
