import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "~/components/ui/button";

export function Hero({ skillCount }: { skillCount: number }) {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pt-24 pb-16 text-center sm:px-8 sm:pt-32 sm:pb-24">
      <p className="mb-10 text-xs uppercase tracking-[0.22em] text-ink-faint">
        Labee · Research Skills at Scale
      </p>

      <blockquote className="font-display text-3xl leading-tight tracking-tight text-ink sm:text-5xl">
        <span className="italic">
          &ldquo;The musicians play their instruments. I play the orchestra.&rdquo;
        </span>
      </blockquote>
      <p className="mt-6 text-sm text-ink-light">— Steve Jobs</p>

      <p className="mt-12 max-w-xl text-balance text-base leading-relaxed text-ink-light sm:text-lg">
        A catalog of {skillCount} artifacts — Claude skills and user-authored
        protocols — available on this machine. Browse, search, and open each
        one to read what it does and which tools it orchestrates.
      </p>

      <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
        <Button size="lg" render={<Link to="/chat" />}>
          Open project
          <ArrowRight size={16} />
        </Button>
        <Button variant="link" size="lg" render={<Link to="/skills" />}>
          Browse artifacts
          <ArrowRight size={16} />
        </Button>
      </div>
    </section>
  );
}
