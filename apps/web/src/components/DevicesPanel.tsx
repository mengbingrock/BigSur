// Settings › Devices: approve or reject phones/tablets that asked to pair
// with this Mac through labee.online, and list/revoke approved ones.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiSend } from "~/lib/api";

interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  status: "pending" | "approved" | "revoked";
  code: string | null;
  createdAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
}

export function DevicesPanel() {
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ["link", "pending"],
    queryFn: () => apiGet<{ devices: DeviceInfo[]; error?: string }>("/api/link/pending"),
    refetchInterval: 5000,
    retry: false,
  });
  const all = useQuery({
    queryKey: ["link", "devices"],
    queryFn: () => apiGet<{ devices: DeviceInfo[] }>("/api/link/devices"),
    refetchInterval: 15000,
    retry: false,
  });
  const decide = async (id: string, decision: "approve" | "reject") => {
    await apiSend("POST", `/api/link/pending/${id}/${decision}`);
    await Promise.all([qc.invalidateQueries({ queryKey: ["link", "pending"] }), qc.invalidateQueries({ queryKey: ["link", "devices"] })]);
  };
  const revoke = async (id: string) => {
    await apiSend("DELETE", `/api/link/devices/${id}`);
    await qc.invalidateQueries({ queryKey: ["link", "devices"] });
  };
  const pendingList = pending.data?.devices ?? [];
  const approved = (all.data?.devices ?? []).filter((d) => d.status === "approved");

  return (
    <section className="rounded-xl border border-border bg-card p-5" data-testid="devices-panel">
      <h2 className="font-display text-base text-ink">Devices</h2>
      <p className="mt-1 text-sm text-ink-light">
        Phones and tablets that can attach to this Mac's sessions through labee.online. Approve a device only if the
        code on its screen matches.
      </p>
      {pending.error ? <p className="mt-3 text-sm text-ink-light">{(pending.error as Error).message}</p> : null}
      {pendingList.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {pendingList.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-lg border border-amber-400/60 bg-amber-50/40 p-3 dark:bg-amber-900/10">
              <div>
                <div className="text-sm font-medium text-ink">
                  {d.name} <span className="text-ink-light">({d.platform ?? "device"}) wants to attach</span>
                </div>
                <div className="font-mono text-lg tracking-[0.3em] text-ink">{d.code}</div>
              </div>
              <div className="flex gap-2">
                <button type="button" className="rounded-md bg-ink px-3 py-1.5 text-sm text-background" onClick={() => void decide(d.id, "approve")}>
                  Approve
                </button>
                <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-ink" onClick={() => void decide(d.id, "reject")}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-4 flex flex-col divide-y divide-border">
        {approved.length === 0 ? <li className="py-2 text-sm text-ink-light">No approved devices yet.</li> : null}
        {approved.map((d) => (
          <li key={d.id} className="flex items-center justify-between py-2">
            <div className="text-sm text-ink">
              {d.name} <span className="text-ink-light">· {d.platform ?? ""}{d.lastSeenAt ? ` · seen ${new Date(d.lastSeenAt).toLocaleString()}` : ""}</span>
            </div>
            <button type="button" className="text-sm text-ink-light hover:text-ink" onClick={() => void revoke(d.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
