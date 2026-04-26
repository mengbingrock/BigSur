import { getSession } from "@/lib/session";
import { createUser, isSignupEnabled } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!isSignupEnabled()) {
    return Response.json({ error: "Signup is disabled." }, { status: 403 });
  }
  let body: { email?: string; password?: string };
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
    const user = await createUser(email, password);
    const session = await getSession();
    session.email = user.email;
    session.isAdmin = user.isAdmin;
    await session.save();
    return Response.json({ ok: true, email: user.email, isAdmin: user.isAdmin });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
