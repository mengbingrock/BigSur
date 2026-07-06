import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "~/components/AuthForm";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { next, error } = Route.useSearch();
  return <AuthForm mode="login" next={next ?? "/chat"} initialError={error} />;
}
