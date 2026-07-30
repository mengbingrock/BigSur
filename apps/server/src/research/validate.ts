// Tiny structural validators for sub-agent JSON outputs. Deliberately plain
// (no Schema dependency): error messages are fed back to the model verbatim
// on the retry attempt, so they must be short and actionable.

export function vObject(u: unknown, name = "value"): Record<string, unknown> {
  if (typeof u !== "object" || u === null || Array.isArray(u)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return u as Record<string, unknown>;
}

export function vArray(u: unknown, name = "value"): unknown[] {
  if (!Array.isArray(u)) throw new Error(`${name} must be an array`);
  return u;
}

export function vString(u: unknown, name = "value"): string {
  if (typeof u !== "string") throw new Error(`${name} must be a string`);
  return u;
}

export function vNumber(u: unknown, name = "value"): number {
  if (typeof u !== "number" || !Number.isFinite(u)) throw new Error(`${name} must be a number`);
  return u;
}

export function vBoolean(u: unknown, name = "value"): boolean {
  if (typeof u !== "boolean") throw new Error(`${name} must be a boolean`);
  return u;
}

export function vStringArray(u: unknown, name = "value"): string[] {
  return vArray(u, name).map((s, i) => vString(s, `${name}[${i}]`));
}

export function optString(u: unknown): string | null {
  return typeof u === "string" ? u : null;
}

/** Filesystem-safe slug for ref ids and keys. */
export function fsSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "x";
}
