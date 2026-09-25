import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { Skill } from "@labee/contracts";
import { Hero } from "~/components/Hero";
import { apiGet } from "~/lib/api";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/")({
  component: Home,
});

/** Signed in → straight into the chat workspace, which reopens the most recent
 *  session (or the one last open on this device). The hero is only for people
 *  who are not signed in, i.e. visitors to the public site. */
function Home() {
  const navigate = useNavigate();
  const { data: user, isLoading } = useCurrentUser();

  useEffect(() => {
    if (!isLoading && user) navigate({ to: "/chat", replace: true });
  }, [isLoading, user, navigate]);

  const { data } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
    enabled: !isLoading && !user,
  });

  if (isLoading || user) {
    return (
      <div className="flex h-full w-full items-center justify-center py-24 text-sm text-ink-light">
        Opening your latest chat…
      </div>
    );
  }
  return <Hero skillCount={data?.skills.length ?? 0} />;
}
