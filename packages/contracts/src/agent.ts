import { Schema } from "effect";

/** Which locally-installed CLI runs this agent. */
export const AgentEngine = Schema.Literals(["claude", "codex"]);
export type AgentEngine = typeof AgentEngine.Type;

/**
 * A saved agent preset: a named bundle of selected skills, a working artifact
 * directory (where the agent runs and writes outputs), and folders on the
 * user's computer that contain reference protocols (read-only references).
 */
export const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Slugs of skills activated for this agent. */
  skillSlugs: Schema.Array(Schema.String),
  /** Absolute path to the working artifact directory (the chat's cwd). */
  workingDir: Schema.String,
  /** Absolute paths to folders holding reference protocols / docs. */
  referenceFolders: Schema.Array(Schema.String),
  /** Which local CLI runs the agent (defaults to "claude"). */
  engine: Schema.optional(AgentEngine),
  /** Name of the team this agent belongs to, when it's one of a set designed
   *  to work together; research runs hand off along the team order. */
  team: Schema.optional(Schema.NullOr(Schema.String)),
  /** Position in the team's hand-off order (1-based; 0 = unordered). */
  teamOrder: Schema.optional(Schema.Number),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
export type Agent = typeof Agent.Type;

/** Create/update payload for an agent. */
export const AgentUpdate = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  skillSlugs: Schema.Array(Schema.String),
  workingDir: Schema.String,
  referenceFolders: Schema.Array(Schema.String),
  engine: Schema.optional(AgentEngine),
});
export type AgentUpdate = typeof AgentUpdate.Type;

/** One directory entry returned by the folder-browse API. */
export const FsDir = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
export type FsDir = typeof FsDir.Type;

/** Response of GET /api/fs/browse. */
export const FsBrowse = Schema.Struct({
  path: Schema.String,
  parent: Schema.NullOr(Schema.String),
  home: Schema.String,
  dirs: Schema.Array(FsDir),
  /** Files in this directory, present only when the caller asked for them. */
  files: Schema.optional(Schema.Array(FsDir)),
});
export type FsBrowse = typeof FsBrowse.Type;
