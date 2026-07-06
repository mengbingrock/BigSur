// Minimal preload. The renderer is the web app loaded over loopback http, so
// it needs no privileged bridge today. contextIsolation stays on; we expose
// only a tiny read-only info object (e.g. for showing "Desktop vX" in the UI).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("labeeDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Start Google sign-in in the system browser (so the user's saved Google
  // accounts are available). Main relays the session back to the window — over
  // IPC in embedded mode, or via a one-shot loopback listener in remote mode.
  signInWithGoogle: (next?: string): Promise<void> =>
    ipcRenderer.invoke("labee:google-sign-in", next),
  // Native OS folder picker; resolves to the chosen absolute path or null.
  pickFolder: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("labee:pick-folder", defaultPath),
  // Connect the user's hosted Labee account (opens hosted sign-in in the system
  // browser, persists a box session) so the local app can sync agents/skills.
  connectToLabee: (): Promise<boolean> => ipcRenderer.invoke("labee:connect-labee"),
});
