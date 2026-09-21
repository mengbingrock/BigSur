// Settings › Labee connection (desktop only): which labee.online account this
// Mac is linked to, whether the Device Link is up, and a button to (re)connect.
// Until now the connect flow only ran implicitly from "Sync from Labee".
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "~/lib/api";
import { desktopBridge } from "~/lib/desktop";

interface LinkStatus {
  desktop: boolean;
  server?: string;
  hostId?: string;
  connected?: boolean;
  account?: string | null;
  link?: "disabled" | "no_session" | "connecting" | "connected" | "reconnecting";
}

const LINK_LABEL: Record<NonNullable<LinkStatus["link"]>, string> = {
  disabled: "off",
  no_session: "not connected",
  connecting: "connecting…",
  connected: "connected — phones can attach to this Mac",
  reconnecting: "reconnecting…",
};

export function LabeeConnectionPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["link", "status"],
    queryFn: () => apiGet<LinkStatus>("/api/link/status"),
    refetchInterval: 5000,
    retry: false,
  });
  const d = desktopBridge();
  if (!q.data?.desktop && !d?.isDesktop) return null;
  const st = q.data;
  const connect = async () => {
    if (!d?.connectToLabee) return;
    setBusy(true);
    setMsg(null);
    try {
      const ok = await d.connectToLabee();
      setMsg(ok ? "Connected. The link comes up within a minute." : "Sign-in was cancelled.");
      await qc.invalidateQueries({ queryKey: ["link", "status"] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="labee-connection-panel">
      <h2 className="font-display text-base text-ink">Labee connection</h2>
      <p className="mt-1 text-sm text-ink-light">
        Link this Mac to your labee.online account so your phone and the web can attach to its sessions. The agent keeps
        running here; labee.online only relays.
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-light">Server</dt>
        <dd className="text-ink">{st?.server ?? "labee.online"}</dd>
        <dt className="text-ink-light">Account</dt>
        <dd className="text-ink">{st?.account ?? (st?.connected ? "session saved (not verified)" : "not connected")}</dd>
        <dt className="text-ink-light">Device Link</dt>
        <dd className="text-ink">{st?.link ? LINK_LABEL[st.link] : "…"}</dd>
        {st?.hostId ? (
          <>
            <dt className="text-ink-light">This Mac</dt>
            <dd className="font-mono text-xs text-ink">{st.hostId}</dd>
          </>
        ) : null}
      </dl>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy || !d?.connectToLabee}
          className="rounded-md bg-ink px-3 py-1.5 text-sm text-background disabled:opacity-50"
        >
          {busy ? "Waiting for sign-in…" : st?.account ? "Reconnect to Labee" : "Connect to Labee"}
        </button>
        {msg ? <span className="text-sm text-ink-light">{msg}</span> : null}
      </div>
    </section>
  );
}
