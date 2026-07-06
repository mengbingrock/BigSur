// Client-safe deck surface: the wire types live in @labee/contracts, the pure
// formatter lives in ./format. Re-exported here so both server and browser code
// import deck helpers from one place without pulling node:fs into the bundle.
export type { DeckFile, DeckEntryKind } from "@labee/contracts";
export { formatBytes } from "./format";
