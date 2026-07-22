import { withAdminAuth, withAuth } from "@/lib/session";
import { getSkillsRepoConfig } from "@/lib/runtime-settings";
import { skillRepository } from "@/application/skill";
import { fetchSkillsRepoSnapshot } from "@/infrastructure/github/skillsRepoClient";
import { syncSkillsFromSnapshot } from "@/application/skill/syncSkills";

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
    const snapshot = await fetchSkillsRepoSnapshot();
    const result = await syncSkillsFromSnapshot(skillRepository, snapshot);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    const status = message.includes("GitHub") ? 502 : 500;
    return Response.json({ error: message }, { status });
  }
});
