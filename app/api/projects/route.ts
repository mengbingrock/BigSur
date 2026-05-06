import { NextRequest } from "next/server";
import { getCurrentEmail } from "@/lib/session";
import { createProject, listProjects } from "@/lib/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const projects = await listProjects(email);
  return Response.json({ projects });
}

export async function POST(req: NextRequest) {
  const email = await getCurrentEmail();
  if (!email) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const name = (body?.name ?? "").trim();
  try {
    const project = await createProject(email, name);
    return Response.json({ project }, { status: 201 });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    const msg = err instanceof Error ? err.message : "Could not create project.";
    const status = code === "EXISTS" ? 409 : code === "BAD_NAME" ? 400 : 500;
    return Response.json({ error: msg }, { status });
  }
}
