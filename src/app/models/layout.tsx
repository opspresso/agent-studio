import { assertIntelligenceVisible } from "@/app/_lib/intelligenceGate";

export const metadata = { title: "Models" };

export default async function ModelsLayout({ children }: { children: React.ReactNode }) {
  await assertIntelligenceVisible();
  return children;
}
