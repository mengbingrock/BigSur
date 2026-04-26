export type SkillSource =
  | { kind: "user" }
  | { kind: "plugin"; marketplace: string };

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
}
