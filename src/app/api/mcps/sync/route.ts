import { withAdminAuth, withAuth } from "@/lib/session";
import { getToolsRepoConfig } from "@/lib/runtime-settings";
import { syncToolsFromRepo } from "@/lib/container";

export const GET = withAuth(async () => {
  const { repo, branch, token } = await getToolsRepoConfig();
  return Response.json({
    configured: Boolean(repo && token),
    repo: repo ?? null,
    branch,
  });
});

export const POST = withAdminAuth(async () => {
  const repoConfig = await getToolsRepoConfig();
  if (!repoConfig.repo || !repoConfig.token) {
    return Response.json({ error: "TOOLS_REPO and GITHUB_TOKEN are not configured" }, { status: 503 });
  }
  try {
    return Response.json(await syncToolsFromRepo(repoConfig));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    const status = message.includes("GitHub") ? 502 : 500;
    return Response.json({ error: message }, { status });
  }
});
