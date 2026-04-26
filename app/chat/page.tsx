import Chat from "@/components/Chat";
import { getAllSkills } from "@/lib/skills";

export const metadata = {
  title: "Chat — Monterey",
  description: "Chat with Claude, optionally specialized by one or more skills.",
};

export default function ChatPage() {
  const skills = getAllSkills();
  return (
    <section className="mx-auto max-w-6xl px-6 pb-16 pt-12">
      <header className="mb-10">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Chat
        </p>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink sm:text-5xl">
          Talk to the skills
        </h1>
        <p className="mt-4 max-w-xl text-muted">
          Pick one or more skills on the left. Their full SKILL.md instructions
          become the assistant&apos;s system prompt.
        </p>
      </header>
      <Chat skills={skills} />
    </section>
  );
}
