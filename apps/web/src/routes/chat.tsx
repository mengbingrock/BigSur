import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

function ChatPage() {
  // Placeholder — the canvas + chat workspace is ported in a following step.
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted">
      <h1 className="font-serif text-3xl text-ink">Project workspace</h1>
      <p className="mt-4 text-sm">The chat + canvas workspace is being ported.</p>
    </div>
  );
}
