// Minimal preload. The renderer is the web app loaded over loopback http, so
// it needs no privileged bridge today. contextIsolation stays on; we expose
// only a tiny read-only info object (e.g. for showing "Desktop vX" in the UI).
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("labeeDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
