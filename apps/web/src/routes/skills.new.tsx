import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/skills/new")({
  component: NewSkillPage,
});

function NewSkillPage() {
  // Placeholder — the artifact editor is ported in a following step.
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted">
      <h1 className="font-serif text-3xl text-ink">New artifact</h1>
      <p className="mt-4 text-sm">The artifact editor is being ported.</p>
    </div>
  );
}
