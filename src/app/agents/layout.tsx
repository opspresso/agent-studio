import { assertIntelligenceVisible } from "@/app/_lib/intelligenceGate";

export const metadata = { title: "Agents" };

export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  await assertIntelligenceVisible();
  return children;
}
