import { getAllSkills, getAllSources } from "@/lib/skills";
import SkillSearch from "@/components/SkillSearch";

export const metadata = {
  title: "Skills — Monterey",
};

export default function SkillsPage() {
  const skills = getAllSkills();
  const sources = getAllSources(skills);

  return (
    <section className="mx-auto max-w-6xl px-6 pb-24 pt-16">
      <header className="mb-12">
        <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted">
          Catalog
        </p>
        <h1 className="font-serif text-4xl leading-tight tracking-tight text-ink sm:text-5xl">
          Research Skills
        </h1>
        <p className="mt-4 max-w-xl text-muted">
          Every SKILL.md discovered on this machine. Filter by source, search by
          name, description, or tool.
        </p>
      </header>

      {skills.length === 0 ? (
        <div className="border border-dashed border-rule p-10 text-center text-sm text-muted">
          <p>No skills were indexed.</p>
          <p className="mt-2">
            Put SKILL.md files under <code>~/.claude/skills/</code> or set{" "}
            <code>SKILLS_ROOTS</code> to a list of directories.
          </p>
        </div>
      ) : (
        <SkillSearch skills={skills} sources={sources} />
      )}
    </section>
  );
}
