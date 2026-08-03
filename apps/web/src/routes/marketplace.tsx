import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent, AgentInstallResult, PublicAgent } from "@labee/contracts";
import { ArrowRight, Download, Globe, Loader2, LogIn, Store, Users } from "lucide-react";

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

  const installAll = useMutation({
    mutationFn: async (ids: string[]) => {
      // Sequential: each install is an independent write, and stopping at the
      // first failure leaves a clearer state than a half-parallel scatter.
      const installed: string[] = [];
      for (const id of ids) {
        const r = await apiSend<AgentInstallResult>("POST", `/api/agents/market/${id}/install`);
        installed.push(r.agent.name);
      }
      return installed;
    },
    onSuccess: (names) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent-market"] });
      setMsg({
        ok: true,
        text: `Installed ${names.length} agents: ${names.join(", ")}. Give each one a working folder in Agents.`,
      });
    },
    onError: (e) =>
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Installing the team failed." }),
  });

  const ownIds = new Set((ownQ.data?.agents ?? []).map((a) => a.id));
  const listings = marketQ.data?.agents ?? [];

  // The server returns teams contiguous and in hand-off order; preserve that.
  const teams: Array<{ name: string; members: PublicAgent[] }> = [];
  const loners: PublicAgent[] = [];
  for (const listing of listings) {
    if (!listing.team) {
      loners.push(listing);
      continue;
    }
    const existing = teams.find((t) => t.name === listing.team);
    if (existing) existing.members.push(listing);
    else teams.push({ name: listing.team, members: [listing] });
  }

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
          <div className="flex flex-col gap-10">
            {teams.map((team) => {
              const memberIds = team.members.map((m) => m.id);
              const allOwned = team.members.every((m) => ownIds.has(m.id));
              return (
                <section
                  key={team.name}
                  className="rounded-xl border-2 border-border bg-surface/40 p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 font-medium text-ink text-lg">
                        <Users className="size-5 shrink-0 text-ink-faint" />
                        {team.name}
                        <Badge variant="secondary">team of {team.members.length}</Badge>
                      </h2>
                      <p className="mt-1 max-w-2xl text-ink-light text-sm">
                        These agents are designed to work together as a pipeline — each one&apos;s
                        output is the next one&apos;s input. Install the whole set to run the flow
                        end to end, or take a single agent if you only need that step.
                      </p>
                    </div>
                    {user && !allOwned ? (
                      <Button
                        size="sm"
                        disabled={installAll.isPending || install.isPending}
                        onClick={() => installAll.mutate(memberIds.filter((id) => !ownIds.has(id)))}
                      >
                        {installAll.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Download className="size-4" />
                        )}
                        Install team
                      </Button>
                    ) : null}
                  </div>

                  {/* hand-off order */}
                  <ol className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ink-light text-xs">
                    {team.members.map((m, i) => (
                      <li key={m.id} className="flex items-center gap-1.5">
                        {i > 0 ? <ArrowRight className="size-3 text-ink-faint" /> : null}
                        <span className="rounded-full border border-border bg-card px-2 py-0.5">
                          {m.name}
                        </span>
                      </li>
                    ))}
                  </ol>

                  <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {team.members.map((listing, i) => (
                      <ListingCard
                        key={listing.id}
                        listing={listing}
                        step={i + 1}
                        signedIn={!!user}
                        owned={ownIds.has(listing.id)}
                        installing={install.isPending || installAll.isPending}
                        onInstall={() => install.mutate(listing.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}

            {loners.length > 0 ? (
              <section>
                {teams.length > 0 ? (
                  <h2 className="mb-4 font-medium text-ink">Individual agents</h2>
                ) : null}
                <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {loners.map((listing) => (
                    <ListingCard
                      key={listing.id}
                      listing={listing}
                      signedIn={!!user}
                      owned={ownIds.has(listing.id)}
                      installing={install.isPending || installAll.isPending}
                      onInstall={() => install.mutate(listing.id)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ListingCard({
  listing,
  step,
  signedIn,
  owned,
  installing,
  onInstall,
}: {
  listing: PublicAgent;
  step?: number;
  signedIn: boolean;
  owned: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-baseline gap-1.5 font-medium text-ink">
            {step ? <span className="text-ink-faint text-xs tabular-nums">{step}.</span> : null}
            <span className="truncate">{listing.name}</span>
          </h3>
          {listing.description ? (
            <p className="mt-0.5 line-clamp-3 text-ink-light text-sm">{listing.description}</p>
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
        {!signedIn ? (
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/login" search={{ next: "/marketplace" } as never} />}
          >
            <LogIn className="size-4" />
            Sign in to install
          </Button>
        ) : owned ? (
          <span className="text-ink-faint text-xs">Your listing</span>
        ) : (
          <Button size="sm" disabled={installing} onClick={onInstall}>
            {installing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Install
          </Button>
        )}
      </div>
    </li>
  );
}
