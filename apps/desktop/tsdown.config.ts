import { defineConfig } from "tsdown";

// Compile the Electron main + preload to CommonJS in dist-electron/. CJS keeps
// preload sandbox-compatible and avoids ESM entry caveats in Electron.
export default defineConfig({
  entry: {
    main: "src/main.ts",
    preload: "src/preload.ts",
  },
  format: "cjs",
  outDir: "dist-electron",
  platform: "node",
  target: "node20",
  external: ["electron"],
  clean: true,
  dts: false,
});
