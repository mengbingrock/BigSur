// Minimal preload. The renderer is the Next.js web app loaded over loopback
// http, so it needs no privileged bridge today. We keep contextIsolation on
// and expose only a tiny read-only info object for potential UI use (e.g.
// showing "Desktop vX" somewhere).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("montereyDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
