import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
  // Placeholder — the admin user management UI is ported in a following step.
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted">
      <h1 className="font-serif text-3xl text-ink">User administration</h1>
      <p className="mt-4 text-sm">The admin panel is being ported.</p>
    </div>
  );
}
