import { defineConfig } from "tsdown";

// Compile the Electron main + preload to CommonJS in dist-electron/. CJS keeps
// preload sandbox-compatible and avoids ESM entry caveats in Electron.
//
// Build them as TWO independent bundles. In a single multi-entry build, rolldown
// hoists the shared runtime into main.cjs and makes preload.cjs `require()` it —
// which drags the whole main process (app/BrowserWindow side effects) into the
// renderer, where it throws before the preload can expose its bridge. Separate
// builds keep each entry self-contained.
const common = {
  format: "cjs",
  outDir: "dist-electron",
  platform: "node",
  target: "node20",
  external: ["electron"],
  dts: false,
} as const;

export default defineConfig([
  // Re-specify `external` as a mutable array (the `as const` above makes it
  // readonly, which tsdown's config type rejects).
  { ...common, external: ["electron"], entry: { main: "src/main.ts" }, clean: true },
  { ...common, external: ["electron"], entry: { preload: "src/preload.ts" }, clean: false },
]);
