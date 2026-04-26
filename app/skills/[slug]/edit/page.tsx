import { notFound, redirect } from "next/navigation";
import { getSkillBySlug } from "@/lib/skills";
import { getCurrentUser } from "@/lib/session";
import SkillEditor from "@/components/SkillEditor";

export const dynamic = "force-dynamic";

interface Props {
  params: { slug: string };
}

export const metadata = { title: "Edit skill — Monterey" };

export default async function SkillEditPage({ params }: Props) {
  // Middleware enforces login on /skills/:path*. Any signed-in user can edit
  // user-source skills; plugin-source skills fall through to the read-only
  // message below.
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/skills/${params.slug}/edit`);

  const skill = getSkillBySlug(params.slug);
  if (!skill) notFound();

  if (skill.source.kind !== "user") {
    return (
      <section className="mx-auto max-w-2xl px-6 pb-24 pt-16 text-center">
        <h1 className="font-serif text-3xl text-ink">Read-only skill</h1>
        <p className="mt-4 text-muted">
          This skill comes from a plugin marketplace ({skill.sourceLabel}) and
          cannot be edited from here. Edit it in the source repository instead.
        </p>
      </section>
    );
  }

  return <SkillEditor skill={skill} />;
}
