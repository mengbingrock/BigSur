import { requireAdmin } from "@/lib/admin-guard";
import { deleteUser, resetPassword, setAdmin } from "@/lib/users";

export const runtime = "nodejs";

interface Ctx {
  params: { email: string };
}

function extractEmail(ctx: Ctx): string {
  return decodeURIComponent(ctx.params.email);
}

export async function POST(req: Request, ctx: Ctx) {
  const check = await requireAdmin();
  if ("response" in check) return check.response;

  let body: { password?: string; isAdmin?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const email = extractEmail(ctx);

  try {
    if (typeof body.isAdmin === "boolean") {
      if (!body.isAdmin && email === check.email) {
        return Response.json(
          { error: "You can't demote yourself. Promote someone else first." },
          { status: 400 },
        );
      }
      const ok = await setAdmin(email, body.isAdmin);
      if (!ok) return Response.json({ error: "Not found." }, { status: 404 });
    }
    if (typeof body.password === "string" && body.password) {
      const ok = await resetPassword(email, body.password);
      if (!ok) return Response.json({ error: "Not found." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const check = await requireAdmin();
  if ("response" in check) return check.response;
  const email = extractEmail(ctx);
  if (email === check.email) {
    return Response.json(
      { error: "You can't delete your own account." },
      { status: 400 },
    );
  }
  const ok = await deleteUser(email);
  if (!ok) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ ok: true });
}
