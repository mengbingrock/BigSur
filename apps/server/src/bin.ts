import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { runServer } from "./server";
import { startLinkClient } from "./services/deviceLink/client";
import { seedPublicProtocols } from "./services/seedProtocols";
import { primeFolderCache } from "./services/userFolders";

// Keep the embedded server alive: a single request's stream error (e.g. an
// enqueue after the client aborted a chat) must never take down the whole
// process — otherwise every subsequent request fails with "Failed to fetch".
process.on("uncaughtException", (err) => {
  console.error("[labee] uncaughtException (ignored):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[labee] unhandledRejection (ignored):", reason);
});

// Ship a starter protocol library: copied into the shared _public folder the
// first time a server boots with an empty one, never overwriting anything.
seedPublicProtocols();

// Load the folder grants before serving: the artifact scanner reads them
// synchronously, so an empty cache would briefly hide a person's protocols.
void primeFolderCache();

// Desktop: dial the labee.online Device Link so phones can attach (no-op on
// the box or when no account is connected yet).
startLinkClient();

runServer.pipe(NodeRuntime.runMain);
