export type SkillSource =
  | { kind: "user" }
  | { kind: "public" }
  | { kind: "plugin"; marketplace: string };

export type ArtifactKind = "skill" | "protocol";

export interface Skill {
  slug: string;
  name: string;
  description: string;
  allowedTools: string[];
  license?: string;
  body: string;
  source: SkillSource;
  sourceLabel: string;
  /** Absolute path of the directory containing SKILL.md. */
  sourcePath: string;
  /**
   * Whether this artifact is a generic Claude skill or a user-authored
   * laboratory protocol. Read from frontmatter `kind:`; defaults to "skill".
   */
  artifactKind: ArtifactKind;
}
