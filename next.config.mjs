/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Electron desktop build can ship and run the full Next.js server (API
  // routes, auth, file storage) without a system Node install. Harmless for
  // `next dev` / `next start` / the existing server deploy.
  output: "standalone",
  experimental: {
    // Keep these libraries off the webpack RSC graph and let Node's CommonJS
    // loader handle them at runtime. pdfjs-dist (used by pdf-parse) crashes
    // with "Object.defineProperty called on non-object" when bundled by
    // Next.js's server-component packer; mammoth has its own dynamic-import
    // quirks. Loading them externally avoids both classes of breakage.
    serverComponentsExternalPackages: [
      "pdf-parse",
      "pdfjs-dist",
      "mammoth",
    ],
  },
};

export default nextConfig;
