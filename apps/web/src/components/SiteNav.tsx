import { Link } from "@tanstack/react-router";
import { Loader2, LogOut } from "lucide-react";
import { useCurrentUser, useLogout } from "~/lib/auth";

function LogoutButton() {
  const logout = useLogout();
  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      className="inline-flex items-center gap-1 text-xs text-muted transition hover:text-ink disabled:opacity-60"
    >
      {logout.isPending ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />}
      Sign out
    </button>
  );
}

export function SiteNav() {
  const { data: user } = useCurrentUser();
  return (
    <header className="border-b border-rule">
      <div className="flex w-full items-center justify-between gap-4 px-6 py-5 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-2 text-ink">
          <span className="inline-block h-2 w-2 rounded-full bg-ink" aria-hidden />
          <span className="font-serif text-lg tracking-tight">Labee</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted">
          <Link to="/skills" className="transition hover:text-ink">
            Artifacts
          </Link>
          <Link to="/chat" className="transition hover:text-ink">
            Project
          </Link>
          {user?.isAdmin && (
            <Link to="/admin/users" className="transition hover:text-ink">
              Admin
            </Link>
          )}
          <a
            href="https://docs.anthropic.com/en/docs/claude-code"
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-ink"
          >
            Docs
          </a>
          {user ? (
            <div className="flex items-center gap-3 border-l border-rule pl-6">
              <span
                title={user.email}
                className="max-w-[14rem] truncate font-mono text-xs text-ink"
              >
                {user.email}
                {user.isAdmin && (
                  <span className="ml-1.5 rounded-sm border border-rule px-1 text-[9px] uppercase tracking-[0.1em] text-muted">
                    admin
                  </span>
                )}
              </span>
              <LogoutButton />
            </div>
          ) : (
            <Link to="/login" className="border-l border-rule pl-6 transition hover:text-ink">
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
