import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import SkillEditor from "~/components/SkillEditor";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/skills/new")({
  component: NewSkillPage,
});

function NewSkillPage() {
  const navigate = useNavigate();
  const { data: user, isLoading } = useCurrentUser();

  useEffect(() => {
    if (!isLoading && !user) navigate({ to: "/login", search: { next: "/skills/new" } });
  }, [isLoading, user, navigate]);

  if (isLoading || !user) {
    return <p className="mx-auto max-w-3xl px-6 py-16 text-sm text-muted">Loading…</p>;
  }
  return <SkillEditor mode="create" />;
}
