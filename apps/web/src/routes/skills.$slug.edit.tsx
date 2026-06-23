import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/skills/$slug/edit")({
  component: EditSkillPage,
});

function EditSkillPage() {
  const { slug } = Route.useParams();
  // Placeholder — the artifact editor is ported in a following step.
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted">
      <h1 className="font-serif text-3xl text-ink">Edit artifact</h1>
      <p className="mt-4 text-sm font-mono">{slug}</p>
      <p className="mt-2 text-sm">The artifact editor is being ported.</p>
    </div>
  );
}
