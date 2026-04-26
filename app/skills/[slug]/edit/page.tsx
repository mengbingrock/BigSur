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
  // user-source skills they own; plugin-source skills fall through to the
  // read-only message below.
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/skills/${params.slug}/edit`);

  const skill = getSkillBySlug(params.slug, user.email);
  if (!skill) notFound();

  if (skill.source.kind !== "user") {
    const explanation =
      skill.source.kind === "public"
        ? "It lives in the shared _public folder and is visible to every user. Edit it on disk if you need to change it."
        : `It comes from a plugin marketplace (${skill.sourceLabel}) — edit it in the source repository instead.`;
    return (
      <section className="mx-auto max-w-2xl px-6 pb-24 pt-16 text-center">
        <h1 className="font-serif text-3xl text-ink">Read-only skill</h1>
        <p className="mt-4 text-muted">{explanation}</p>
      </section>
    );
  }

  return <SkillEditor skill={skill} />;
}
