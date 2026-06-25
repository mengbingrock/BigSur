
import { useState, useTransition } from "react";
import {
  Loader2,
  Trash2,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  UserPlus,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { Badge } from "~/components/ui/badge";

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
  const [users, setUsers] = useState(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  const refresh = () => {
    startTransition(() => {
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
        <h2 className="mb-4 font-display text-lg tracking-tight text-ink">
          Create user
        </h2>
        <form
          onSubmit={onCreate}
          className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-xs sm:flex-row sm:items-end"
        >
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Email</span>
            <Input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">Password</span>
            <Input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className="inline-flex items-center gap-2 py-1.5 text-sm text-ink-light sm:pb-2">
            <Checkbox
              checked={newIsAdmin}
              onCheckedChange={(checked) => setNewIsAdmin(checked === true)}
            />
            admin
          </label>
          <Button
            type="submit"
            disabled={busyEmail === "__create__" || !newEmail || !newPassword}
          >
            {busyEmail === "__create__" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <UserPlus />
            )}
            Create
          </Button>
        </form>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg tracking-tight text-ink">
            All users
          </h2>
          <span className="text-sm text-ink-light">
            {users.length} user{users.length === 1 ? "" : "s"}
            {isPending && " · refreshing…"}
          </span>
        </div>
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface text-left text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="w-0 px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const busy = busyEmail === u.email;
                const isMe = u.email === currentEmail;
                return (
                  <tr key={u.email} className="border-t border-border">
                    <td className="px-4 py-3 font-mono text-[13px] text-ink">
                      {u.email}
                      {isMe && (
                        <span className="ml-2 font-sans text-xs text-ink-faint">
                          (you)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {u.isAdmin ? (
                        <Badge variant="secondary">
                          <ShieldCheck />
                          admin
                        </Badge>
                      ) : (
                        <span className="text-ink-light">user</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-light">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() => onResetPassword(u.email)}
                          title="Reset password"
                        >
                          <KeyRound />
                          Reset
                        </Button>
                        {u.isAdmin ? (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={busy || isMe}
                            onClick={() => onToggleAdmin(u.email, false)}
                            title={
                              isMe
                                ? "You can't demote yourself"
                                : "Revoke admin"
                            }
                          >
                            <ShieldOff />
                            Demote
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={busy}
                            onClick={() => onToggleAdmin(u.email, true)}
                            title="Grant admin"
                          >
                            <ShieldCheck />
                            Promote
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="xs"
                          disabled={busy || isMe}
                          onClick={() => onDelete(u.email)}
                          title={
                            isMe
                              ? "You can't delete yourself"
                              : "Delete user"
                          }
                        >
                          {busy ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Trash2 />
                          )}
                          Delete
                        </Button>
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
