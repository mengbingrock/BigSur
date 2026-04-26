import { listUsers } from "@/lib/users";
import { getCurrentUser } from "@/lib/session";
import AdminUsersClient from "@/components/AdminUsersClient";

export const metadata = {
  title: "Users — Monterey Admin",
};

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const me = await getCurrentUser();
  const users = await listUsers();
  return (
    <section className="mx-auto max-w-4xl px-6 pb-16 pt-12">
      <header className="mb-10">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Admin
        </p>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink">
          Users
        </h1>
        <p className="mt-4 max-w-xl text-muted">
          Create, delete, reset passwords, and grant/revoke admin. Mirrors the
          <code className="mx-1 font-mono">scripts/users.mjs</code>CLI.
        </p>
      </header>
      <AdminUsersClient
        initialUsers={users}
        currentEmail={me?.email ?? ""}
      />
    </section>
  );
}
