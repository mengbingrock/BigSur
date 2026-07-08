import { Schema } from "effect";

/** Generic Claude skill vs. user-authored laboratory protocol. */
export const ArtifactKind = Schema.Literals(["skill", "protocol"]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** Where an artifact comes from: the signed-in user, the shared public
 *  pool, or an installed plugin marketplace. */
export const SkillSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["user"]) }),
  Schema.Struct({ kind: Schema.Literals(["public"]) }),
  Schema.Struct({ kind: Schema.Literals(["plugin"]), marketplace: Schema.String }),
]);
export type SkillSource = typeof SkillSource.Type;

/** Provenance for an artifact that was pulled in from outside the app. Distinct
 *  from `source`: an imported skill is copied into the user's own folder (so its
 *  `source` is `user` — editable, deletable), while `origin` records where it
 *  came from so the UI can badge it and a future sync can re-fetch the same ref. */
export const SkillOrigin = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["github"]),
    /** "owner/repo". */
    repo: Schema.String,
    /** The ref the user asked for (branch, tag, or SHA). */
    ref: Schema.String,
    /** The commit SHA the ref resolved to at import time (pinned). */
    sha: Schema.String,
    /** Directory inside the repo that held SKILL.md, if not the root. */
    subpath: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literals(["registry"]),
    /** Registry id, e.g. "clawhub". */
    registry: Schema.String,
    /** Package slug, e.g. "@acme/pdf-fill". */
    pkg: Schema.String,
    /** Concrete resolved version. */
    version: Schema.String,
    /** Content digest, when the registry provides one. */
    digest: Schema.optional(Schema.String),
  }),
]);
export type SkillOrigin = typeof SkillOrigin.Type;

export const Skill = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  license: Schema.optional(Schema.String),
  body: Schema.String,
  source: SkillSource,
  sourceLabel: Schema.String,
  /** Where this artifact was imported from, if it wasn't authored locally. */
  origin: Schema.optional(SkillOrigin),
  /** Absolute path of the directory containing SKILL.md (server-only). */
  sourcePath: Schema.String,
  artifactKind: ArtifactKind,
});
export type Skill = typeof Skill.Type;

/** A sibling file inside an artifact directory (references/, images/, …). */
export const SkillFile = Schema.Struct({
  /** Path relative to the skill root, using "/" separators. */
  relPath: Schema.String,
  size: Schema.Number,
  /** Decoded text content, present only for small text files. */
  text: Schema.optional(Schema.String),
  binary: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type SkillFile = typeof SkillFile.Type;

/** Payload for creating or updating an artifact. */
export const SkillUpdate = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  license: Schema.optional(Schema.String),
  body: Schema.String,
  /** When omitted on save, the existing kind is preserved. */
  kind: Schema.optional(ArtifactKind),
});
export type SkillUpdate = typeof SkillUpdate.Type;
