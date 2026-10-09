import { AdminUsage } from "./AdminUsage";

export const metadata = { title: "Usage monitoring" };
export default async function UsagePage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user } = await searchParams;
  return <AdminUsage key={typeof user === "string" ? user : "all"} initialUser={typeof user === "string" ? user : undefined} />;
}
