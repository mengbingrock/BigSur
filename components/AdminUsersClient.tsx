"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Trash2,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  UserPlus,
} from "lucide-react";

interface PublicUser {
  email: string;
  isAdmin: boolean;
  createdAt: string;
}

interface Props {
  initialUsers: PublicUser[];
  currentEmail: string;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminUsersClient({
  initialUsers,
  currentEmail,
}: Props) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const refresh = () => {
    startTransition(() => {
      router.refresh();
      fetch("/api/admin/users")
        .then((r) => r.json())
        .then((d: { users?: PublicUser[] }) => {
          if (d.users) setUsers(d.users);
        })
        .catch(() => {});
    });
  };

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusyEmail("__create__");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          isAdmin: newIsAdmin,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewEmail("");
      setNewPassword("");
      setNewIsAdmin(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusyEmail(null);
    }
  };

  const callUser = async (
    email: string,
    body: { password?: string; isAdmin?: boolean },
  ) => {
    setError(null);
    setBusyEmail(email);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(email)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyEmail(null);
    }
  };

  const onDelete = async (email: string) => {
    if (!confirm(`Delete ${email}? This can't be undone.`)) return;
    setError(null);
    setBusyEmail(email);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(email)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUsers((us) => us.filter((u) => u.email !== email));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyEmail(null);
    }
  };

  const onResetPassword = async (email: string) => {
    const password = prompt(`New password for ${email} (min 8 chars):`);
    if (!password) return;
    await callUser(email, { password });
    if (!error) alert(`Password reset for ${email}.`);
  };

  const onToggleAdmin = async (email: string, makeAdmin: boolean) => {
    await callUser(email, { isAdmin: makeAdmin });
  };

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="mb-4 font-serif text-lg tracking-tight text-ink">
          Create user
        </h2>
        <form
          onSubmit={onCreate}
          className="flex flex-col gap-3 border border-rule p-4 sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-xs uppercase tracking-[0.16em] text-muted">
              Email
            </span>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-xs uppercase tracking-[0.16em] text-muted">
              Password
            </span>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(e) => setNewIsAdmin(e.target.checked)}
              className="h-4 w-4 accent-ink"
            />
            admin
          </label>
          <button
            type="submit"
            disabled={busyEmail === "__create__" || !newEmail || !newPassword}
            className="inline-flex items-center justify-center gap-2 border border-ink bg-ink px-4 py-2 text-sm text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busyEmail === "__create__" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <UserPlus size={14} />
            )}
            Create
          </button>
        </form>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-serif text-lg tracking-tight text-ink">
            All users
          </h2>
          <span className="text-xs text-muted">
            {users.length} user{users.length === 1 ? "" : "s"}
            {isPending && " · refreshing…"}
          </span>
        </div>
        {error && (
          <div className="mb-4 border border-rule bg-ink/5 px-3 py-2 text-xs text-ink">
            {error}
          </div>
        )}
        <div className="border border-rule">
          <table className="w-full text-sm">
            <thead className="border-b border-rule bg-ink/[0.02] text-left text-[10px] uppercase tracking-[0.16em] text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">Email</th>
                <th className="px-4 py-2 font-normal">Role</th>
                <th className="px-4 py-2 font-normal">Created</th>
                <th className="w-0 px-4 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const busy = busyEmail === u.email;
                const isMe = u.email === currentEmail;
                return (
                  <tr key={u.email} className="border-t border-rule">
                    <td className="px-4 py-3 font-mono text-[13px] text-ink">
                      {u.email}
                      {isMe && (
                        <span className="ml-2 text-[11px] text-muted">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink">
                      {u.isAdmin ? (
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck size={12} />
                          admin
                        </span>
                      ) : (
                        <span className="text-muted">user</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-muted">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onResetPassword(u.email)}
                          title="Reset password"
                          className="inline-flex items-center gap-1 rounded-sm border border-rule px-2 py-1 text-[11px] text-ink transition hover:bg-ink/5 disabled:opacity-50"
                        >
                          <KeyRound size={11} />
                          Reset
                        </button>
                        {u.isAdmin ? (
                          <button
                            type="button"
                            disabled={busy || isMe}
                            onClick={() => onToggleAdmin(u.email, false)}
                            title={
                              isMe
                                ? "You can't demote yourself"
                                : "Revoke admin"
                            }
                            className="inline-flex items-center gap-1 rounded-sm border border-rule px-2 py-1 text-[11px] text-ink transition hover:bg-ink/5 disabled:opacity-50"
                          >
                            <ShieldOff size={11} />
                            Demote
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onToggleAdmin(u.email, true)}
                            title="Grant admin"
                            className="inline-flex items-center gap-1 rounded-sm border border-rule px-2 py-1 text-[11px] text-ink transition hover:bg-ink/5 disabled:opacity-50"
                          >
                            <ShieldCheck size={11} />
                            Promote
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy || isMe}
                          onClick={() => onDelete(u.email)}
                          title={
                            isMe
                              ? "You can't delete yourself"
                              : "Delete user"
                          }
                          className="inline-flex items-center gap-1 rounded-sm border border-rule px-2 py-1 text-[11px] text-ink transition hover:bg-ink/5 disabled:opacity-50"
                        >
                          {busy ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Trash2 size={11} />
                          )}
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
