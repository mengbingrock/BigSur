import Hero from "@/components/Hero";
import { getAllSkills } from "@/lib/skills";

export default function HomePage() {
  const skills = getAllSkills();
  return <Hero skillCount={skills.length} />;
}
