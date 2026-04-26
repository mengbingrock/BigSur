import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface HeroProps {
  skillCount: number;
}

export default function Hero({ skillCount }: HeroProps) {
  return (
    <section className="mx-auto flex max-w-3xl flex-col items-center px-6 pt-24 pb-16 text-center sm:pt-32 sm:pb-24">
      <p className="mb-10 text-xs uppercase tracking-[0.22em] text-muted">
        Monterey · Research Skills at Scale
      </p>

      <blockquote className="font-serif text-3xl leading-tight text-ink sm:text-5xl">
        <span className="italic">
          &ldquo;The musicians play their instruments. I play the orchestra.&rdquo;
        </span>
      </blockquote>
      <p className="mt-6 text-sm text-muted">— Steve Jobs</p>

      <p className="mt-12 max-w-xl text-balance text-base leading-relaxed text-muted sm:text-lg">
        A catalog of the {skillCount} research skills installed on this machine.
        Browse, search, and open each skill to read what it does and which tools it
        orchestrates.
      </p>

      <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row sm:gap-8">
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 text-sm font-medium text-paper transition hover:opacity-90"
        >
          Open the chat
          <ArrowRight size={16} />
        </Link>
        <Link
          href="/skills"
          className="inline-flex items-center gap-2 border-b border-ink pb-1 text-sm font-medium text-ink transition hover:gap-3"
        >
          Browse the catalog
          <ArrowRight size={16} />
        </Link>
      </div>
    </section>
  );
}
