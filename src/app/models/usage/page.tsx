import { UsageExplorer } from "@/app/_components/UsageExplorer";

export const metadata = { title: "Model usage" };
export default async function ModelUsagePage({ searchParams }: { searchParams: Promise<{ model?: string }> }) {
  const { model } = await searchParams;
  return <UsageExplorer key={typeof model === "string" ? model : "all"} initialModel={typeof model === "string" ? model : undefined} />;
}
