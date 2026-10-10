// Entry point. Two modes from one binary:
//
//   node bin.mjs                 the Labee server
//   node bin.mjs --mcp-library   the library MCP server, over stdio — spawned
//                                by the claude CLI for a chat turn, pointed at
//                                the running server by env (LABEE_MCP_BASE,
//                                LABEE_MCP_COOKIE)
//
// The MCP mode loads nothing of the server: no database, no config, no link
// client. It is a thin HTTP client that happens to live in the same bundle so
// there is one thing to ship.
export {};

if (process.argv.includes("--mcp-library")) {
  const { serveLibraryMcp } = await import("./mcp/libraryMcp");
  await serveLibraryMcp();
} else {
  const [{ default: NodeRuntime }, { runServer }, { startLinkClient }, { primeFolderCache }] = await Promise.all([
    import("@effect/platform-node/NodeRuntime").then((m) => ({ default: m })),
    import("./server"),
    import("./services/deviceLink/client"),
    import("./services/userFolders"),
  ]);

  // Keep the embedded server alive: a single request's stream error (e.g. an
  // enqueue after the client aborted a chat) must never take down the whole
  // process — otherwise every subsequent request fails with "Failed to fetch".
  process.on("uncaughtException", (err) => {
    console.error("[labee] uncaughtException (ignored):", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[labee] unhandledRejection (ignored):", reason);
  });

  // Load the folder grants before serving: the artifact scanner reads them
  // synchronously, so an empty cache would briefly hide a person's protocols.
  void primeFolderCache();

  // Desktop: dial the labee.online Device Link so phones can attach (no-op on
  // the box or when no account is connected yet).
  startLinkClient();

  runServer.pipe(NodeRuntime.runMain);
}
