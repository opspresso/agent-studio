import { assertIntelligenceVisible } from "@/app/_lib/intelligenceGate";

export const metadata = { title: "Plugins" };

export default async function PluginsLayout({ children }: { children: React.ReactNode }) {
  await assertIntelligenceVisible();
  return children;
}
