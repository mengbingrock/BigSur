import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent } from "@labee/contracts";
import { ChevronLeft, Loader2 } from "lucide-react";

import { apiGet } from "~/lib/api";
import { AgentEditor } from "~/components/AgentEditor";
import { Button } from "~/components/ui/button";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/agents/$id/edit")({
  component: EditAgentPage,
});

function EditAgentPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/agents" } });
  }, [authLoading, user, navigate]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => apiGet<{ agent: Agent }>("/api/agents/" + id),
    enabled: !!user,
  });

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-10 sm:px-8">
      <Button size="sm" variant="ghost" render={<Link to="/agents" />} className="mb-4">
        <ChevronLeft className="size-4" />
        Agents
      </Button>
      <h1 className="font-display text-3xl text-ink tracking-tight">Edit agent</h1>

      <div className="mt-8">
        {authLoading || isLoading ? (
          <div className="flex items-center gap-2 text-ink-light text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading agent…
          </div>
        ) : isError ? (
          <p className="text-destructive text-sm">
            {error instanceof Error ? error.message : "Failed to load agent."}
          </p>
        ) : data?.agent ? (
          <AgentEditor initial={data.agent} onSaved={() => navigate({ to: "/agents" })} />
        ) : (
          <p className="text-ink-light text-sm">Agent not found.</p>
        )}
      </div>
    </div>
  );
}
