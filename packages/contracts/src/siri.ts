/** References identify canonical records, not a position in a recent-chat list. */
export interface ContextRef {
  hostId?: string;
  sessionId?: string;
  runId?: string;
  messageIdx?: number;
  eventSeq?: number;
}

export type ContextTool =
  | "sessions.search"
  | "sessions.read"
  | "messages.read"
  | "sessions.events"
  | "runs.search"
  | "runs.read"
  | "protocols.search"
  | "protocols.read"
  | "tasks.search"
  | "tasks.read"
  | "index.status"
  | "index.build";

export interface ContextCall extends ContextRef {
  tool: ContextTool;
  query?: string;
  mode?: "lexical" | "semantic" | "hybrid";
  cursor?: string;
  limit?: number;
  direction?: "before" | "after";
  status?: string;
  archived?: boolean;
  since?: string;
  until?: string;
  includeEvents?: boolean;
  protocolSlug?: string;
  /** Hierarchy address from a protocol search or tree read. */
  nodeId?: string;
  revision?: string;
  taskId?: string;
  part?: "state" | "snapshot" | "events" | "tree";
  offset?: number;
  /** Prevent a forwarded request from recursively federating. */
  localOnly?: boolean;
}

export interface ContextCoverage {
  indexing: boolean;
  complete: boolean;
  sources: Array<{
    hostId: string;
    mirrored: boolean;
    online: boolean;
    syncedAt?: string;
    messageThrough?: number;
    eventThrough?: number;
    complete: boolean;
  }>;
  unavailableHosts: string[];
}

export interface ContextResult {
  items: Array<Record<string, unknown>>;
  coverage: ContextCoverage;
  mode?: "lexical" | "semantic" | "hybrid";
  embedding?: {
    model: string;
    total: number;
    embedded: number;
    pending: number;
    indexing: boolean;
    available: boolean;
    ready: boolean;
  };
  nextCursor?: string;
  previousCursor?: string;
  hasMore: boolean;
  /** A long record's remaining content can be read by exact reference. */
  nextOffset?: number;
}
