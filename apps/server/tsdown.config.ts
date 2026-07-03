import { defineConfig } from "tsdown";

// Bundle the server and all its npm deps into a single self-contained ESM
// file, so the packaged desktop app can ship just dist/bin.mjs (+ the web
// client beside it). The embedded SQLite drivers are runtime builtins and
// must stay external.
export default defineConfig({
  entry: ["src/bin.ts"],
  format: "esm",
  outDir: "dist",
  platform: "node",
  target: "node20",
  clean: true,
  noExternal: [/.*/],
  external: ["bun:sqlite", "node:sqlite", "electron"],
  dts: false,
  // We intentionally bundle every dependency (noExternal) into one file, so
  // silence tsdown's "unintended bundling" advisory. It's a warning on macOS but
  // is escalated to a fatal error on the Windows CI runner, breaking that build.
  inlineOnly: false,
});
