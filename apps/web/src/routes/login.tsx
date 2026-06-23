import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "~/components/AuthForm";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: LoginPage,
});

function LoginPage() {
  const { next } = Route.useSearch();
  return <AuthForm mode="login" next={next ?? "/chat"} />;
}
