import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { attempt, bodyJson, error, sessionUser } from "../httpKit";
import {
  createUser,
  deleteUser,
  findUser,
  listUsers,
  resetPassword,
  setAdmin,
  toPublic,
} from "../services/users";

const params = HttpRouter.params;

const safeBody = <T>() =>
  bodyJson<T>().pipe(Effect.catch(() => Effect.succeed(null as T | null)));

/** Resolve the caller and confirm they are an admin per the on-disk record. */
const requireAdmin = Effect.gen(function* () {
  const user = yield* sessionUser;
  if (!user) return { ok: false as const, status: 401, message: "Authentication required." };
  const record = yield* Effect.promise(() => findUser(user.email));
  if (!record?.isAdmin) return { ok: false as const, status: 403, message: "Admin access required." };
  return { ok: true as const, email: user.email };
});

/** GET /api/admin/users — list every account. */
export const listUsersRoute = HttpRouter.add(
  "GET",
  "/api/admin/users",
  Effect.gen(function* () {
    const guard = yield* requireAdmin;
    if (!guard.ok) return yield* error(guard.message, guard.status);
    return yield* attempt(async () => ({ users: await listUsers() }));
  }),
);

/** POST /api/admin/users — create an account. */
export const createUserRoute = HttpRouter.add(
  "POST",
  "/api/admin/users",
  Effect.gen(function* () {
    const guard = yield* requireAdmin;
    if (!guard.ok) return yield* error(guard.message, guard.status);
    const body = yield* safeBody<{ email: string; password: string; isAdmin?: boolean }>();
    if (!body?.email || !body.password) return yield* error("email and password are required.", 400);
    return yield* attempt(async () => ({
      user: toPublic(await createUser(body.email, body.password, { isAdmin: Boolean(body.isAdmin) })),
    }));
  }),
);

/** PUT /api/admin/users/:email — update admin flag and/or password. */
export const updateUserRoute = HttpRouter.add(
  "PUT",
  "/api/admin/users/:email",
  Effect.gen(function* () {
    const guard = yield* requireAdmin;
    if (!guard.ok) return yield* error(guard.message, guard.status);
    const { email } = yield* params;
    const target = decodeURIComponent(email ?? "");
    const body = yield* safeBody<{ isAdmin?: boolean; password?: string }>();
    if (!body) return yield* error("Invalid JSON body.", 400);
    return yield* attempt(async () => {
      if (typeof body.isAdmin === "boolean") await setAdmin(target, body.isAdmin);
      if (body.password) await resetPassword(target, body.password);
      return { ok: true };
    });
  }),
);

/** DELETE /api/admin/users/:email — remove an account. */
export const deleteUserRoute = HttpRouter.add(
  "DELETE",
  "/api/admin/users/:email",
  Effect.gen(function* () {
    const guard = yield* requireAdmin;
    if (!guard.ok) return yield* error(guard.message, guard.status);
    const { email } = yield* params;
    const target = decodeURIComponent(email ?? "");
    if (target === guard.email) return yield* error("You cannot delete your own account.", 400);
    return yield* attempt(async () => ({ ok: await deleteUser(target) }));
  }),
);

export const adminRoutes = [
  listUsersRoute,
  createUserRoute,
  updateUserRoute,
  deleteUserRoute,
] as const;
