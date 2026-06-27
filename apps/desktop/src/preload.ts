// Minimal preload. The renderer is the web app loaded over loopback http, so
// it needs no privileged bridge today. contextIsolation stays on; we expose
// only a tiny read-only info object (e.g. for showing "Desktop vX" in the UI).
import { contextBridge, ipcRenderer } from "electron";

// Remote mode (pointing at the hosted server) uses the normal in-window web
// Google redirect, so the loopback bridge is omitted — the web GoogleButton then
// falls back to window.location to the server's /api/auth/google route.
const isRemote = process.argv.includes("--labee-remote");

contextBridge.exposeInMainWorld("labeeDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Embedded only: start Google sign-in via the system browser; main relays the
  // session back. Omitted in remote mode (GoogleButton checks for this).
  ...(isRemote
    ? {}
    : {
        signInWithGoogle: (next?: string): Promise<void> =>
          ipcRenderer.invoke("labee:google-sign-in", next),
      }),
});
