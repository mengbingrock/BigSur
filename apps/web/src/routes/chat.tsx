import { Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { DeckFile, Skill } from "@labee/contracts";
import Chat from "~/components/Chat";
import { apiGet } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/chat")({
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

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/chat" } });
  }, [authLoading, user, navigate]);

  if (authLoading || !user || skillsQ.isLoading || deckQ.isLoading) return <Loading />;

  return (
    <div className="h-[calc(100vh-8rem)]">
      <Suspense fallback={<Loading />}>
        <Chat
          skills={skillsQ.data?.skills ?? []}
          initialDeckFiles={deckQ.data?.files ?? []}
          deckMaxBytes={deckQ.data?.maxBytes ?? 0}
        />
      </Suspense>
    </div>
  );
}
