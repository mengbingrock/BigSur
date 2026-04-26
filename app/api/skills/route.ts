import { NextRequest } from "next/server";
import { createSkill } from "@/lib/skills";
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
  if (typeof v !== "string") throw new Error(`${field} must be a string.`);
  return v;
}

function asStringArray(v: unknown, field: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`${field} must be an array.`);
  return v
    .map((x, i) => {
      if (typeof x !== "string") {
        throw new Error(`${field}[${i}] must be a string.`);
      }
      return x.trim();
    })
    .filter(Boolean);
}

function errorResponse(err: unknown): Response {
  const msg = err instanceof Error ? err.message : "Unknown error.";
  const code = (err as { code?: string } | null)?.code;
  let status = 500;
  if (code === "INVALID") status = 400;
  else if (code === "CONFLICT") status = 409;
  else if (code === "NO_ROOT") status = 500;
  return Response.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  // Auth (any signed-in user) is enforced by middleware on /api/skills/:path*;
  // we re-fetch the email here to scope the write to the caller's own folder.
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  try {
    const created = createSkill(
      {
        name: asString(body.name, "name").trim(),
        description: asString(body.description ?? "", "description"),
        allowedTools: asStringArray(body.allowedTools, "allowedTools"),
        license: typeof body.license === "string" ? body.license : undefined,
        body: asString(body.body ?? "", "body"),
      },
      email,
    );
    return Response.json({ skill: created }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
