import Link from "next/link";
import LogoutButton from "./LogoutButton";

interface NavUser {
  email: string;
  isAdmin: boolean;
}

export default function Nav({ user }: { user: NavUser | null }) {
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-5">
        <Link href="/" className="flex items-center gap-2 text-ink">
          <span className="inline-block h-2 w-2 rounded-full bg-ink" aria-hidden />
          <span className="font-serif text-lg tracking-tight">Monterey</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted">
          <Link href="/skills" className="transition hover:text-ink">
            Skills
          </Link>
          <Link href="/chat" className="transition hover:text-ink">
            Chat
          </Link>
          {user?.isAdmin && (
            <Link href="/admin/users" className="transition hover:text-ink">
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
            <Link
              href="/login"
              className="border-l border-rule pl-6 transition hover:text-ink"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
