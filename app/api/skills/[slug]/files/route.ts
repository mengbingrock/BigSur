import { NextRequest } from "next/server";
import { saveSkillFile } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

interface Body {
  relPath?: unknown;
  content?: unknown;
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

export async function PUT(
  req: NextRequest,
  { params }: { params: { slug: string } },
) {
  const email = await getCurrentEmail();
  if (!email) return Response.json({ error: "Unauthorized." }, { status: 401 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (typeof body.relPath !== "string" || typeof body.content !== "string") {
    return Response.json(
      { error: "relPath and content must be strings." },
      { status: 400 },
    );
  }

  try {
    saveSkillFile(params.slug, body.relPath, body.content, email);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
