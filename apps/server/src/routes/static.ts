import { Effect, FileSystem, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import Mime from "@effect/platform-node/Mime";
import { ServerConfig } from "../config";

/** GET * — serve the built web client, falling back to index.html for SPA
 *  client-side routes. In dev, redirect to the Vite dev server. */
export const staticRoute = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl) {
      const target = new URL(url.value.pathname + url.value.search, config.devUrl);
      return HttpServerResponse.redirect(target.href, { status: 302 });
    }
    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured.", { status: 503 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const requestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawRelative = requestPath.replace(/^[/\\]+/, "");
    const relative = path.normalize(rawRelative).replace(/^[/\\]+/, "");
    if (
      relative.length === 0 ||
      rawRelative.startsWith("..") ||
      relative.startsWith("..") ||
      relative.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const withinRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, relative);
    if (!withinRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const serveIndex = Effect.gen(function* () {
      const indexData = yield* fileSystem
        .readFile(path.resolve(staticRoot, "index.html"))
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) return HttpServerResponse.text("Not Found", { status: 404 });
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    });

    if (!path.extname(filePath)) {
      // Extensionless route (SPA path) → index.html.
      return yield* serveIndex;
    }

    const info = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!info || info.type !== "File") {
      return yield* serveIndex;
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) return HttpServerResponse.text("Internal Server Error", { status: 500 });
    return HttpServerResponse.uint8Array(data, { status: 200, contentType });
  }),
);
