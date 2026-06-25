import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LlmSettingsPanel } from "~/components/LlmSettingsPanel";
import { useCurrentUser } from "~/lib/auth";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const { data: user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/login", search: { next: "/settings" } });
  }, [authLoading, user, navigate]);

  if (authLoading || !user) {
    return (
      <div className="flex h-full w-full items-center justify-center py-24 text-sm text-ink-light">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background/80 px-6 backdrop-blur">
        <span className="font-display text-[1.0625rem] text-ink">Settings</span>
      </header>
      <div className="p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
          <LlmSettingsPanel />
        </div>
      </div>
    </div>
  );
}
