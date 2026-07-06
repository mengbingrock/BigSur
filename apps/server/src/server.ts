import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { ServerConfig, ServerConfigLive } from "./config";
import { routesLayer } from "./http";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** HTTP server backend: Bun under `bun run`, Node under the compiled binary. */
const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (isBun) {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    }
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      port: config.port,
      ...(config.host ? { host: config.host } : {}),
    });
  }),
);

/** FileSystem + Path services for static serving. */
const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (isBun) {
      const BunServices = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return BunServices.layer;
    }
    const NodeServices = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
    return NodeServices.layer;
  }),
);

const AppLayer = HttpRouter.serve(routesLayer).pipe(
  Layer.provideMerge(HttpServerLive),
  Layer.provideMerge(PlatformServicesLive),
  Layer.provideMerge(ServerConfigLive),
);

export const runServer = Layer.launch(AppLayer);
