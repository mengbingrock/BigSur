// Post-build step: Next.js `output: "standalone"` emits a self-contained
// server in .next/standalone, but intentionally omits the static assets and
// the public/ folder. Copy them in so the standalone server (and the packaged
// Electron app) can serve /_next/static/* and public files.
//
// Run after `next build`, before `electron-builder`.
import { cp, access, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    "[prepare-standalone] .next/standalone not found — run `next build` " +
      "with output:'standalone' in next.config first.",
  );
  process.exit(1);
}

async function copyIfExists(from, to, label) {
  try {
    await access(from);
  } catch {
    console.log(`[prepare-standalone] skip ${label} (not present): ${from}`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[prepare-standalone] copied ${label} -> ${path.relative(root, to)}`);
}

await copyIfExists(
  path.join(root, ".next", "static"),
  path.join(standalone, ".next", "static"),
  "static assets",
);
await copyIfExists(
  path.join(root, "public"),
  path.join(standalone, "public"),
  "public/",
);

console.log("[prepare-standalone] done.");
