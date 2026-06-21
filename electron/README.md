# Monterey Desktop (Electron)

Wraps the Monterey Next.js app as a desktop app for **macOS** and **Windows**.

Monterey is a full Next.js *server* app (API routes, session auth, file
storage), so the desktop build doesn't ship static files — it runs the Next.js
**standalone server** (`.next/standalone/server.js`) as a child process and
points an Electron window at it (`http://127.0.0.1:<free-port>`).

## How it works

- `next.config.mjs` sets `output: "standalone"` → `next build` emits a
  self-contained server under `.next/standalone`.
- `electron/prepare-standalone.mjs` copies `.next/static` (and `public/` if
  present) into the standalone dir, which Next intentionally omits.
- `electron/main.js`:
  - **dev** (`ELECTRON_DEV=1`): loads `http://localhost:3000` from a running
    `next dev` (no server forked).
  - **prod**: forks the standalone `server.js` using Electron's bundled Node
    (`ELECTRON_RUN_AS_NODE`), on a free loopback port, then loads it.
- `electron-builder` packages the app; the standalone dir is copied into the
  app's `resources/standalone` via `extraResources` (kept **outside** the asar
  so the server file can be forked).

## Writable data

The app bundle is read-only, so the server's writable paths are redirected to
the OS per-user data dir (`app.getPath("userData")`):

- `MONTEREY_DATA_DIR` → `…/userData/data` (users.json etc.)
- `DECK_ROOT` → `…/userData/monterey-decks`
- `SESSION_PASSWORD` → a 64-char secret generated once and stored in
  `…/userData/session-secret.txt` (so logins survive restarts)

macOS: `~/Library/Application Support/Monterey`
Windows: `%APPDATA%/Monterey`

## Scripts

```bash
npm run electron:dev      # next dev + electron, hot reload (loads :3000)
npm run electron:start    # build + run electron against the local prod server
npm run dist:dir          # build an UNPACKED app (fast, no installer/signing)
npm run dist:mac          # build macOS .dmg + .zip       -> release/
npm run dist:win          # build Windows NSIS installer  -> release/
npm run dist              # build for the current platform
```

## Building installers

- **macOS** (`dist:mac`): produces `.dmg` and `.zip` in `release/`. Unsigned by
  default (Gatekeeper will warn). To sign/notarize, set up a "Developer ID
  Application" certificate and `CSC_*` / notarization env vars — see
  https://electron.build/code-signing.
- **Windows** (`dist:win`): produces an NSIS installer. **Best built on Windows
  or CI.** Cross-building from macOS/Linux needs Wine; if you build on Windows
  you get a proper `.exe` installer with no extra setup.

## Icons (optional)

Drop icons in `build/` and electron-builder picks them up automatically:

- `build/icon.icns` (macOS)
- `build/icon.ico` (Windows, 256×256)
- `build/icon.png` (Linux, 512×512)

Without them the default Electron icon is used.

## Notes / limitations

- Some API routes shell out to a `claude` CLI (chat, extract-choices). Those
  features need that binary available on the user's machine; it isn't bundled.
- The renderer loads over plain http on loopback, so `COOKIE_SECURE=false` is
  set for the desktop session cookie.
