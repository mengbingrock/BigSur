import { requireAdmin } from "@/lib/admin-guard";
import { createUser, listUsers, toPublic } from "@/lib/users";

export const runtime = "nodejs";

export async function GET() {
  const check = await requireAdmin();
  if ("response" in check) return check.response;
  const users = await listUsers();
  return Response.json({ users });
}

export async function POST(req: Request) {
  const check = await requireAdmin();
  if ("response" in check) return check.response;

  let body: { email?: string; password?: string; isAdmin?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !password) {
    return Response.json(
      { error: "Email and password are required." },
      { status: 400 },
    );
  }
  try {
    const user = await createUser(email, password, {
      isAdmin: Boolean(body.isAdmin),
      autoPromoteFirst: false,
    });
    return Response.json({ user: toPublic(user) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Create failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
