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

export const Skill = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  license: Schema.optional(Schema.String),
  body: Schema.String,
  source: SkillSource,
  sourceLabel: Schema.String,
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
