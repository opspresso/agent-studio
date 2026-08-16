import { assertIntelligenceVisible } from "@/app/_lib/intelligenceGate";

export const metadata = { title: "Tools" };

export default async function ToolsLayout({ children }: { children: React.ReactNode }) {
  await assertIntelligenceVisible();
  return children;
}
