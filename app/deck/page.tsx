import { redirect } from "next/navigation";
import { getCurrentEmail } from "@/lib/session";
import {
  formatBytes,
  getMaxUploadBytes,
  listDeck,
  userDeckDir,
} from "@/lib/deck";
import DeckClient from "@/components/DeckClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Deck — Monterey",
  description:
    "Your private file deck. Upload files for skills to read and find files skills produce.",
};

export default async function DeckPage() {
  const email = await getCurrentEmail();
  if (!email) redirect("/login?next=/deck");

  const files = await listDeck(email);
  const maxBytes = getMaxUploadBytes();
  const dir = userDeckDir(email);

  return (
    <section className="mx-auto max-w-4xl px-6 pb-24 pt-12">
      <header className="mb-8">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Your files
        </p>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink sm:text-5xl">
          Deck
        </h1>
        <p className="mt-4 max-w-2xl text-muted">
          Persistent per-user file storage. Anything you upload is mounted into
          your chat sessions at <code className="font-mono text-ink">./deck/</code>{" "}
          so the spawned skills can read your inputs and write outputs that
          show up here.
        </p>
        <p className="mt-2 font-mono text-[11px] text-muted">
          {dir} · max {formatBytes(maxBytes)} per file
        </p>
      </header>

      <DeckClient initialFiles={files} maxBytes={maxBytes} />
    </section>
  );
}
