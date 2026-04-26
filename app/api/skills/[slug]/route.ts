import { NextRequest } from "next/server";
import { deleteSkill, getSkillBySlug, saveSkill } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  description?: unknown;
  allowedTools?: unknown;
  license?: unknown;
  body?: unknown;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return v;
}

function asStringArray(v: unknown, field: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`${field} must be an array.`);
  return v.map((x, i) => {
    if (typeof x !== "string") throw new Error(`${field}[${i}] must be a string.`);
    return x.trim();
  }).filter(Boolean);
}

function errorResponse(err: unknown): Response {
  const msg = err instanceof Error ? err.message : "Unknown error.";
  const code = (err as { code?: string } | null)?.code;
  let status = 500;
  if (code === "NOT_FOUND") status = 404;
  else if (code === "READ_ONLY") status = 400;
  else if (code === "PATH_ESCAPE") status = 400;
  else if (code === "INVALID") status = 400;
  return Response.json({ error: msg }, { status });
}

async function requireEmail(): Promise<string | Response> {
  const email = await getCurrentEmail();
  if (!email) return Response.json({ error: "Unauthorized." }, { status: 401 });
  return email;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const email = await requireEmail();
  if (typeof email !== "string") return email;

  const skill = getSkillBySlug(params.slug, email);
  if (!skill) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ skill });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const email = await requireEmail();
  if (typeof email !== "string") return email;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  try {
    const update = {
      name: asString(body.name, "name").trim(),
      description: asString(body.description ?? "", "description"),
      allowedTools: asStringArray(body.allowedTools, "allowedTools"),
      license: typeof body.license === "string" ? body.license : undefined,
      body: asString(body.body ?? "", "body"),
    };
    const saved = saveSkill(params.slug, update, email);
    return Response.json({ skill: saved });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const email = await requireEmail();
  if (typeof email !== "string") return email;

  try {
    deleteSkill(params.slug, email);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
