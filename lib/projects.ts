import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { userDeckDir } from "./deck";

export interface Project {
  name: string;
  modified: string;
}

function isValidProjectName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(name) &&
    !name.startsWith(".")
  );
}

export async function listProjects(email: string): Promise<Project[]> {
  const dir = userDeckDir(email);
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    try {
      const stat = await fsp.stat(path.join(dir, entry.name));
      out.push({ name: entry.name, modified: stat.mtime.toISOString() });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}

export async function createProject(
  email: string,
  name: string,
): Promise<Project> {
  if (!isValidProjectName(name)) {
    const err = new Error(
      "Project name must be 1–64 chars, start alphanumeric, and contain only letters, digits, spaces, dots, dashes, or underscores.",
    );
    (err as Error & { code: string }).code = "BAD_NAME";
    throw err;
  }
  const deckDir = userDeckDir(email);
  await fsp.mkdir(deckDir, { recursive: true });
  const target = path.join(deckDir, name);
  const rel = path.relative(deckDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const err = new Error("Project name escapes deck.");
    (err as Error & { code: string }).code = "PATH_ESCAPE";
    throw err;
  }
  if (fs.existsSync(target)) {
    const err = new Error("A project with that name already exists.");
    (err as Error & { code: string }).code = "EXISTS";
    throw err;
  }
  await fsp.mkdir(target);
  const stat = await fsp.stat(target);
  return { name, modified: stat.mtime.toISOString() };
}
