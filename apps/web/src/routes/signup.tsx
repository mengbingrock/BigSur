import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "~/components/AuthForm";

export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: SignupPage,
});

function SignupPage() {
  const { next } = Route.useSearch();
  return <AuthForm mode="signup" next={next ?? "/chat"} />;
}
