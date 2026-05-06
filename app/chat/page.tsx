import Chat from "@/components/Chat";
import { getAllSkills } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";
import { getMaxUploadBytes, listDeck } from "@/lib/deck";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Project — Monterey",
  description:
    "Your project workspace. Working directory + artifacts on the left, chat on the right.",
};

export default async function ChatPage() {
  const email = await getCurrentEmail();
  const skills = getAllSkills(email ?? undefined);
  const deckFiles = email ? await listDeck(email) : [];
  const deckMaxBytes = getMaxUploadBytes();
  return (
    <section className="w-full px-6 pb-16 pt-12 sm:px-8 lg:px-12">
      <header className="mb-10">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Project
        </p>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink sm:text-5xl">
          Your project workspace
        </h1>
        <p className="mt-4 max-w-xl text-muted">
          Working directory and active artifacts on the left. Chat fills the
          rest of the page.
        </p>
      </header>
      <Chat
        skills={skills}
        initialDeckFiles={deckFiles}
        deckMaxBytes={deckMaxBytes}
      />
    </section>
  );
}
