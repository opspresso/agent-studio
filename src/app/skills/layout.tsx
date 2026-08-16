import { assertIntelligenceVisible } from "@/app/_lib/intelligenceGate";

export const metadata = { title: "Skills" };

export default async function SkillsLayout({ children }: { children: React.ReactNode }) {
  await assertIntelligenceVisible();
  return children;
}
