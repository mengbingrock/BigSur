import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import AdminUsersClient from "~/components/AdminUsersClient";
import { apiGet } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";

interface PublicUser {
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const navigate = useNavigate();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiGet<{ users: PublicUser[] }>("/api/admin/users"),
    enabled: !!user?.isAdmin,
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/admin/users" } });
    else if (!authLoading && user && !user.isAdmin) navigate({ to: "/chat" });
  }, [authLoading, user, navigate]);

  if (authLoading || !user?.isAdmin || usersQ.isLoading) {
    return <p className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted">Loading…</p>;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12 sm:px-8">
      <p className="mb-2 text-xs uppercase tracking-[0.22em] text-muted">Administration</p>
      <h1 className="mb-8 font-serif text-4xl tracking-tight text-ink">Users</h1>
      <AdminUsersClient initialUsers={usersQ.data?.users ?? []} currentEmail={user.email} />
    </div>
  );
}
