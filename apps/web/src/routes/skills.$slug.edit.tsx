import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { Skill, SkillFile } from "@labee/contracts";
import SkillEditor from "~/components/SkillEditor";
import { Button } from "~/components/ui/button";
import { apiGet } from "~/lib/api";

export const Route = createFileRoute("/skills/$slug/edit")({
  component: EditSkillPage,
});

function EditSkillPage() {
  const { slug } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["skill", slug],
    queryFn: () =>
      apiGet<{ skill: Skill; files: SkillFile[] }>(`/api/skills/${encodeURIComponent(slug)}`),
  });

  if (isLoading) {
    return (
      <p className="mx-auto w-full max-w-[860px] px-6 py-16 text-sm text-ink-light sm:px-8">
        Loading…
      </p>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto w-full max-w-[860px] px-6 py-16 sm:px-8">
        <p className="text-sm text-ink-light">Artifact not found.</p>
        <Button variant="link" size="sm" className="mt-4 px-0" render={<Link to="/skills" />}>
          ← Back to artifacts
        </Button>
      </div>
    );
  }
  return <SkillEditor skill={data.skill} mode="edit" />;
}
