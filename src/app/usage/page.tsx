import { UsageExplorer } from "@/app/_components/UsageExplorer";

export const metadata = { title: "Usage monitoring" };
export default async function UsagePage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user } = await searchParams;
  return <UsageExplorer admin key={typeof user === "string" ? user : "all"} initialUser={typeof user === "string" ? user : undefined} />;
}
