import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { runServer } from "./server";

// Keep the embedded server alive: a single request's stream error (e.g. an
// enqueue after the client aborted a chat) must never take down the whole
// process — otherwise every subsequent request fails with "Failed to fetch".
process.on("uncaughtException", (err) => {
  console.error("[labee] uncaughtException (ignored):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[labee] unhandledRejection (ignored):", reason);
});

runServer.pipe(NodeRuntime.runMain);
