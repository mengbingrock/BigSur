import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import { createDeckDir } from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const name = (body?.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "name is required." }, { status: 400 });
  }
  try {
    const entry = await createDeckDir(email, name);
    return Response.json({ entry }, { status: 201 });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const msg = err instanceof Error ? err.message : "Could not create directory.";
    const status =
      code === "EXISTS"
        ? 409
        : code === "BAD_NAME" || code === "PATH_ESCAPE"
          ? 400
          : 500;
    return Response.json({ error: msg }, { status });
  }
}
