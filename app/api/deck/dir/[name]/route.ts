import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import { listDeckSubdir } from "@/lib/deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFor(err: unknown): number {
  const code = (err as { code?: string } | null)?.code;
  if (code === "NOT_FOUND") return 404;
  if (code === "BAD_NAME" || code === "PATH_ESCAPE" || code === "BAD_KIND")
    return 400;
  return 500;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { name: string } },
) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let name: string;
  try {
    name = decodeURIComponent(params.name);
  } catch {
    return Response.json({ error: "Invalid name." }, { status: 400 });
  }
  try {
    const files = await listDeckSubdir(email, name);
    return Response.json({ files });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "List failed.";
    return Response.json({ error: msg }, { status: statusFor(err) });
  }
}
