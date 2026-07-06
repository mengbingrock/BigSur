import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Skill } from "@labee/contracts";
import { Hero } from "~/components/Hero";
import { apiGet } from "~/lib/api";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const { data } = useQuery({
    queryKey: ["skills"],
    queryFn: () => apiGet<{ skills: Skill[] }>("/api/skills"),
  });
  return <Hero skillCount={data?.skills.length ?? 0} />;
}
