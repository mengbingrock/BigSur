import Hero from "@/components/Hero";
import { getAllSkills } from "@/lib/skills";
import { getCurrentEmail } from "@/lib/session";

export default async function HomePage() {
  // Public landing — no email signed in shows only plugin skills (currently
  // none, so the count is fine to show as 0 to anonymous visitors).
  const email = await getCurrentEmail();
  const skills = getAllSkills(email ?? undefined);
  return <Hero skillCount={skills.length} />;
}
