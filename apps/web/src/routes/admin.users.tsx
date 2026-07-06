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
    return (
      <p className="mx-auto w-full max-w-[1080px] px-6 py-10 text-sm text-ink-light sm:px-8">
        Loading…
      </p>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 py-10 sm:px-8">
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.22em] text-ink-faint">
        Administration
      </p>
      <h1 className="mb-8 font-display text-3xl tracking-tight text-ink">Users</h1>
      <AdminUsersClient initialUsers={usersQ.data?.users ?? []} currentEmail={user.email} />
    </div>
  );
}
