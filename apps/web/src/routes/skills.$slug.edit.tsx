import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { Skill, SkillFile } from "@labee/contracts";
import SkillEditor from "~/components/SkillEditor";
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
    return <p className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted">Loading…</p>;
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted">Artifact not found.</p>
        <Link to="/skills" className="mt-4 inline-block text-sm text-ink underline">
          ← Back to artifacts
        </Link>
      </div>
    );
  }
  return <SkillEditor skill={data.skill} mode="edit" />;
}
