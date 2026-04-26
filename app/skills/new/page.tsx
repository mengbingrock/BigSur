import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import SkillEditor from "@/components/SkillEditor";

export const dynamic = "force-dynamic";

export const metadata = { title: "New skill — Monterey" };

export default async function NewSkillPage() {
  // Middleware enforces login on /skills/:path*; this fallback handles the
  // edge case where session lookup fails inside the page itself.
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/skills/new");
  return <SkillEditor mode="create" />;
}
