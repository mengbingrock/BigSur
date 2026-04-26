import { getSession } from "./session";
import { findUser } from "./users";

/**
 * Verify the current caller is an admin, against the on-disk user record
 * (not just the session). Returns the admin's email, or a Response the
 * caller should return directly.
 */
export async function requireAdmin(): Promise<
  { email: string } | { response: Response }
> {
  const session = await getSession();
  if (!session.email) {
    return {
      response: Response.json({ error: "Unauthorized." }, { status: 401 }),
    };
  }
  const user = await findUser(session.email);
  if (!user || !user.isAdmin) {
    return {
      response: Response.json({ error: "Admin only." }, { status: 403 }),
    };
  }
  return { email: user.email };
}
