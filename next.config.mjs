/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
