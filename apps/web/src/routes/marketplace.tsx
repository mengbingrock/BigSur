import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent, AgentInstallResult, PublicAgent } from "@labee/contracts";
import { Download, Globe, Loader2, LogIn, Store } from "lucide-react";

import { apiGet, apiSend } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/marketplace")({
  component: MarketplacePage,
});

/** Public — no auth guard, no redirect to /login. Signed-out visitors browse
 *  listings and are prompted to sign in only when they try to install. */
function MarketplacePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const marketQ = useQuery({
    queryKey: ["agent-market"],
    queryFn: () => apiGet<{ agents: PublicAgent[] }>("/api/agents/market"),
  });

  // Only used to mark the caller's own listings; harmless to skip when signed out.
  const ownQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<{ agents: Agent[] }>("/api/agents"),
    enabled: !!user,
  });

  const install = useMutation({
    mutationFn: (id: string) =>
      apiSend<AgentInstallResult>("POST", `/api/agents/market/${id}/install`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent-market"] });
      setMsg({
        ok: true,
        text:
          `Installed "${r.agent.name}". Pick a working folder to start using it.` +
          (r.droppedSkillSlugs.length
            ? ` Skipped ${r.droppedSkillSlugs.length} private skill${r.droppedSkillSlugs.length === 1 ? "" : "s"} of the publisher (${r.droppedSkillSlugs.join(", ")}).`
            : ""),
      });
      void navigate({ to: "/agents/$id/edit", params: { id: r.agent.id } });
    },
    onError: (e) => setMsg({ ok: false, text: e instanceof Error ? e.message : "Install failed." }),
  });

  const ownIds = new Set((ownQ.data?.agents ?? []).map((a) => a.id));
  const listings = marketQ.data?.agents ?? [];

  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 py-10 sm:px-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-3xl text-ink tracking-tight">
            <Store className="size-6 text-ink-faint" />
            Marketplace
          </h1>
          <p className="mt-1 max-w-2xl text-ink-light text-sm">
            Agents shared publicly by the community. Installing copies the preset — its skills and
            engine — into your account; you choose your own working folder. Publish your own from
            the Agents page.
          </p>
        </div>
        {!user ? (
          <Button variant="outline" render={<Link to="/login" search={{ next: "/marketplace" } as never} />}>
            <LogIn className="size-4" />
            Sign in
          </Button>
        ) : null}
      </div>

      {msg ? (
        <p className={`mt-3 text-sm ${msg.ok ? "text-ink-light" : "text-destructive"}`}>{msg.text}</p>
      ) : null}

      <div className="mt-8">
        {marketQ.isLoading ? (
          <div className="flex items-center gap-2 text-ink-light text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading marketplace…
          </div>
        ) : marketQ.isError ? (
          <p className="text-destructive text-sm">Failed to load the marketplace.</p>
        ) : listings.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border border-dashed bg-card px-6 py-16 text-center">
            <Store className="size-8 text-ink-faint" />
            <p className="font-medium text-ink">No public agents yet</p>
            <p className="max-w-sm text-ink-light text-sm">
              Published agents show up here for everyone. Publish one of yours with the globe button
              on its card in Agents.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {listings.map((listing) => (
              <li
                key={listing.id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium text-ink">{listing.name}</h2>
                    {listing.description ? (
                      <p className="mt-0.5 line-clamp-3 text-ink-light text-sm">
                        {listing.description}
                      </p>
                    ) : null}
                  </div>
                  <Globe className="size-5 shrink-0 text-ink-faint" />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">
                    {listing.skillSlugs.length} skill{listing.skillSlugs.length === 1 ? "" : "s"}
                  </Badge>
                  <Badge variant="outline">{listing.engine ?? "claude"}</Badge>
                  <Badge variant="outline">by {listing.author}</Badge>
                  {listing.installs > 0 ? (
                    <Badge variant="outline">
                      <Download className="size-3" />
                      {listing.installs}
                    </Badge>
                  ) : null}
                </div>

                <div className="mt-1">
                  {!user ? (
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link to="/login" search={{ next: "/marketplace" } as never} />}
                    >
                      <LogIn className="size-4" />
                      Sign in to install
                    </Button>
                  ) : ownIds.has(listing.id) ? (
                    <span className="text-ink-faint text-xs">Your listing</span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={install.isPending}
                      onClick={() => install.mutate(listing.id)}
                    >
                      {install.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Download className="size-4" />
                      )}
                      Install
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
