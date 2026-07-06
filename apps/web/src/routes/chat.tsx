import { Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Agent, DeckFile, Skill } from "@labee/contracts";
import Chat from "~/components/Chat";
import { apiGet } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/chat")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  component: ChatPage,
});

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center py-24 text-sm text-ink-light">
      Loading workspace…
    </div>
  );
}

function ChatPage() {
  const navigate = useNavigate();
  const { agent: agentId } = Route.useSearch();
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const skillsQ = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
    enabled: !!user,
  });
  const deckQ = useQuery({
    queryKey: ["deck"],
    queryFn: () => apiGet<{ files: DeckFile[]; maxBytes: number }>("/api/deck"),
    enabled: !!user,
  });
  const agentQ = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => apiGet<{ agent: Agent }>(`/api/agents/${agentId}`),
    enabled: !!user && !!agentId,
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/chat" } });
  }, [authLoading, user, navigate]);

  if (authLoading || !user || skillsQ.isLoading || deckQ.isLoading) return <Loading />;
  if (agentId && agentQ.isLoading) return <Loading />;

  return (
    <div className="h-full min-h-0">
      <Suspense fallback={<Loading />}>
        <Chat
          skills={skillsQ.data?.skills ?? []}
          initialDeckFiles={deckQ.data?.files ?? []}
          deckMaxBytes={deckQ.data?.maxBytes ?? 0}
          agent={agentQ.data?.agent ?? null}
        />
      </Suspense>
    </div>
  );
}
