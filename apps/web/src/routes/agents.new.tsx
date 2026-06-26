import { useEffect } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { AgentEditor } from "~/components/AgentEditor";
import { Button } from "~/components/ui/button";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/agents/new")({
  component: NewAgentPage,
});

function NewAgentPage() {
  const navigate = useNavigate();
  const { data: user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/agents/new" } });
  }, [authLoading, user, navigate]);

  if (authLoading || !user) {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-6 py-10 text-ink-light text-sm sm:px-8">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-10 sm:px-8">
      <Button size="sm" variant="ghost" render={<Link to="/agents" />} className="mb-4">
        <ChevronLeft className="size-4" />
        Agents
      </Button>
      <h1 className="font-display text-3xl text-ink tracking-tight">New agent</h1>
      <p className="mt-1 mb-8 text-ink-light text-sm">
        Bundle skills, a working directory, and reference folders into a reusable preset.
      </p>
      <AgentEditor onSaved={() => navigate({ to: "/agents" })} />
    </div>
  );
}
