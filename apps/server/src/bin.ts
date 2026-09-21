import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { runServer } from "./server";
import { startLinkClient } from "./services/deviceLink/client";

// Keep the embedded server alive: a single request's stream error (e.g. an
// enqueue after the client aborted a chat) must never take down the whole
// process — otherwise every subsequent request fails with "Failed to fetch".
process.on("uncaughtException", (err) => {
  console.error("[labee] uncaughtException (ignored):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[labee] unhandledRejection (ignored):", reason);
});

// Desktop: dial the labee.online Device Link so phones can attach (no-op on
// the box or when no account is connected yet).
startLinkClient();

runServer.pipe(NodeRuntime.runMain);
