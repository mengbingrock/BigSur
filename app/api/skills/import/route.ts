import { NextRequest } from "next/server";
import { importSkill } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";
import type { Skill } from "@/lib/types";

export const dynamic = "force-dynamic";

interface Body {
  slugs?: unknown;
}

interface ImportResult {
  slug: string;
  ok: true;
  skill: Skill;
}

interface ImportFailure {
  slug: string;
  ok: false;
  error: string;
}

export async function POST(req: NextRequest) {
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

  if (
    !Array.isArray(body.slugs) ||
    body.slugs.length === 0 ||
    body.slugs.some((s) => typeof s !== "string")
  ) {
    return Response.json(
      { error: "Body must be { slugs: string[] } with at least one slug." },
      { status: 400 },
    );
  }

  const slugs = body.slugs as string[];
  const imported: ImportResult[] = [];
  const failed: ImportFailure[] = [];

  for (const slug of slugs) {
    try {
      const skill = importSkill(slug, email);
      imported.push({ slug, ok: true, skill });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      failed.push({ slug, ok: false, error: msg });
    }
  }

  // 207 Multi-Status when there's a mix; 201 on full success; 400 on full
  // failure if every requested skill missed.
  const allFailed = imported.length === 0;
  const status = allFailed ? 400 : failed.length > 0 ? 207 : 201;
  return Response.json({ imported, failed }, { status });
}
