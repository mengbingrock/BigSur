// Settings › Runs on: point this browser at one of your linked Macs, the way
// the iOS app does. Everything relayable — chats, protocols, agents, research,
// the deck — is then served by that Mac over the Device Link tunnel.
//
// The reason this exists is authentication, not convenience. Anthropic does not
// permit a hosted service to hold a Claude subscription credential or route
// requests through it on a user's behalf, so labee.online cannot run a turn on
// your Pro/Max plan. Your Mac can: the CLI there is signed in through
// Anthropic's own flow and the credential never leaves the machine. Selecting a
// Mac here is what lets a browser use that subscription.
import { useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Monitor, Server } from "lucide-react";
import { apiGet, getHostId, setHostId, subscribeHostId } from "~/lib/api";
import { isDesktop } from "~/lib/desktop";

interface HostInfo {
  hostId: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
}

/** Re-render whenever the selected Mac changes, wherever that happened. */
function useHostId(): string | null {
  return useSyncExternalStore(subscribeHostId, getHostId, () => null);
}

export function RunsOnPanel() {
  const qc = useQueryClient();
  const selected = useHostId();
  const hostsQ = useQuery({
    queryKey: ["link", "hosts"],
    queryFn: () => apiGet<{ hosts: HostInfo[] }>("/api/link/hosts"),
    refetchInterval: 15000,
    retry: false,
  });
  const hosts = hostsQ.data?.hosts ?? [];

  const choose = async (hostId: string | null) => {
    if (hostId === selected) return;
    setHostId(hostId);
    // Every cached answer came from the other server, so none of it is true
    // any more. Drop the lot rather than trying to decide what still applies.
    qc.clear();
    await qc.invalidateQueries();
  };

  // The desktop app is already the Mac; relaying to one would be a loop.
  if (isDesktop()) return null;

  const rows: Array<{ id: string | null; name: string; online: boolean; sub: string }> = [
    {
      id: null,
      name: "labee.online",
      online: true,
      sub: "Runs on the server. Needs an API key or Labee credits — a Claude subscription can't be used here.",
    },
    ...hosts.map((h) => ({
      id: h.hostId,
      name: h.name,
      online: h.online,
      sub: h.online
        ? "Online. Runs on your Mac, with whatever account that Mac is signed in to."
        : `Offline${h.lastSeenAt ? ` · last seen ${new Date(h.lastSeenAt).toLocaleString()}` : ""}`,
    })),
  ];

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="runs-on-panel">
      <h2 className="font-display text-base text-ink">Runs on</h2>
      <p className="mt-1 text-sm text-ink-light">
        Choose where your work runs. Pick a Mac to use the Claude or ChatGPT account that Mac is
        signed in to — its login stays on the machine and is never sent to labee.online. This
        choice is remembered in this browser only.
      </p>

      {hostsQ.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-ink-light">
          <Loader2 className="size-3.5 animate-spin" />
          Looking for your Macs…
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {rows.map((r) => {
            const active = r.id === selected;
            return (
              <li key={r.id ?? "box"}>
                <button
                  type="button"
                  onClick={() => void choose(r.id)}
                  aria-pressed={active}
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${
                    active
                      ? "border-accent bg-accent/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  {r.id === null ? (
                    <Server className="size-4 shrink-0 text-ink-faint" />
                  ) : (
                    <Monitor className="size-4 shrink-0 text-ink-faint" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{r.name}</span>
                      {r.id !== null && (
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${r.online ? "bg-emerald-500" : "bg-ink-faint"}`}
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-light">{r.sub}</span>
                  </span>
                  {active ? <span className="shrink-0 text-sm text-accent">Selected</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hosts.length === 0 && !hostsQ.isLoading ? (
        <p className="mt-3 text-sm text-ink-light">
          No Macs linked yet. Open the Labee desktop app and connect it to your account under My
          Device, and it will appear here.
        </p>
      ) : null}
    </section>
  );
}
