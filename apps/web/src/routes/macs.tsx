// Your Macs: desktops linked to this account through the Device Link, with
// the sessions each one mirrors to the box (design §5.4). Works on
// labee.online; on a desktop this page shows the same list via the box.
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SessionSummary } from "@labee/session-core";
import { apiGet } from "~/lib/api";

export const Route = createFileRoute("/macs")({ component: MacsPage });

interface HostInfo {
  hostId: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
}

function HostSessions({ host }: { host: HostInfo }) {
  const q = useQuery({
    queryKey: ["hosts", host.hostId, "sessions"],
    queryFn: () => apiGet<{ sessions: SessionSummary[] }>(`/api/hosts/${encodeURIComponent(host.hostId)}/api/sessions`),
    refetchInterval: 10_000,
  });
  const sessions = q.data?.sessions ?? [];
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${host.online ? "bg-emerald-500" : "bg-border"}`} aria-hidden />
        <h2 className="font-display text-base text-ink">{host.name}</h2>
        <span className="text-xs text-ink-light">
          {host.online ? "online" : `offline${host.lastSeenAt ? ` · last seen ${new Date(host.lastSeenAt).toLocaleString()}` : ""}`}
        </span>
      </div>
      {q.error ? <p className="mt-2 text-sm text-ink-light">{(q.error as Error).message}</p> : null}
      {sessions.length === 0 && !q.isLoading ? <p className="mt-3 text-sm text-ink-light">No sessions mirrored from this Mac yet.</p> : null}
      <ul className="mt-3 divide-y divide-border">
        {sessions.map((s) => (
          <li key={s.id}>
            <Link
              to="/macs/$hostId/$sessionId"
              params={{ hostId: host.hostId, sessionId: s.id }}
              className="flex items-center gap-3 py-2 text-sm text-ink hover:text-ink"
            >
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.status === "running" ? "bg-emerald-500" : s.status === "awaiting_input" ? "bg-amber-500" : "bg-border"}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="shrink-0 text-xs text-ink-light">
                {s.status === "running" ? "running" : s.status === "awaiting_input" ? "waiting on you" : "idle"}
                {s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MacsPage() {
  const hosts = useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiGet<{ hosts: HostInfo[] }>("/api/link/hosts"),
    refetchInterval: 10_000,
  });
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background/80 px-6 backdrop-blur">
        <span className="font-display text-[1.0625rem] text-ink">Your Macs</span>
      </header>
      <div className="p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          {hosts.error ? <p className="text-sm text-ink-light">{(hosts.error as Error).message}</p> : null}
          {hosts.data && hosts.data.hosts.length === 0 ? (
            <p className="text-sm text-ink-light">
              No Mac is linked to this account yet. In the Labee desktop app, use “Connect to Labee” and it will appear here.
            </p>
          ) : null}
          {(hosts.data?.hosts ?? []).map((h) => (
            <HostSessions key={h.hostId} host={h} />
          ))}
        </div>
      </div>
    </div>
  );
}
