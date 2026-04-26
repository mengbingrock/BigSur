import { getSession } from "@/lib/session";
import { verifyCredentials } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: Request) {
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
  const user = await verifyCredentials(email, password);
  if (!user) {
    return Response.json({ error: "Incorrect email or password." }, { status: 401 });
  }
  const session = await getSession();
  session.email = user.email;
  session.isAdmin = user.isAdmin;
  await session.save();
  return Response.json({ ok: true, email: user.email, isAdmin: user.isAdmin });
}
