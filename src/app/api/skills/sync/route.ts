import { withAdminAuth, withAuth } from "@/lib/session";
import { getSkillsRepoConfig } from "@/lib/runtime-settings";
import { syncSkillsFromRepo } from "@/lib/container";

export const GET = withAuth(async () => {
  const { repo, branch, token } = await getSkillsRepoConfig();
  return Response.json({
    configured: Boolean(repo && token),
    repo: repo ?? null,
    branch,
  });
});

export const POST = withAdminAuth(async () => {
  const { repo, token } = await getSkillsRepoConfig();
  if (!repo || !token) {
    return Response.json(
      { error: "SKILLS_REPO and GITHUB_TOKEN are not configured" },
      { status: 503 },
    );
  }
  try {
    return Response.json(await syncSkillsFromRepo());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    const status = message.includes("GitHub") ? 502 : 500;
    return Response.json({ error: message }, { status });
  }
});
