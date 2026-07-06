import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Layer, ServiceMap } from "effect";

export type RuntimeMode = "server" | "desktop";

export interface ServerConfigShape {
  readonly mode: RuntimeMode;
  readonly port: number;
  readonly host: string | undefined;
  /** Directory of the built web client to serve, or undefined in dev. */
  readonly staticDir: string | undefined;
  /** When set, GET * redirects here (Vite dev server) instead of serving files. */
  readonly devUrl: URL | undefined;
}

export class ServerConfig extends ServiceMap.Service<ServerConfig, ServerConfigShape>()(
  "labee/config/ServerConfig",
) {}

/** Locate the built web client: the bundled copy beside the server binary
 *  (desktop/prod) or the monorepo `apps/web/dist` (local build). */
function resolveStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "client"), // bundled next to dist/bin.mjs
    path.resolve(here, "../client"),
    path.resolve(here, "../../web/dist"), // monorepo build
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return undefined;
}

export function resolveServerConfig(): ServerConfigShape {
  const mode: RuntimeMode = process.env.LABEE_MODE === "desktop" ? "desktop" : "server";
  const port = Number(process.env.LABEE_PORT ?? process.env.PORT ?? 3000);
  const host = process.env.LABEE_HOST || undefined;
  const devUrlRaw = process.env.VITE_DEV_SERVER_URL;
  const devUrl = devUrlRaw ? new URL(devUrlRaw) : undefined;
  const staticDir = devUrl ? undefined : resolveStaticDir();
  return { mode, port, host, staticDir, devUrl };
}

export const ServerConfigLive = Layer.succeed(ServerConfig)(resolveServerConfig());
