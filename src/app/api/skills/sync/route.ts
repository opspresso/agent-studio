import { withAuth } from "@/lib/session";
import { config } from "@/lib/config";
import { skillRepository } from "@/application/skill";
import { fetchSkillsRepoSnapshot } from "@/infrastructure/github/skillsRepoClient";
import { syncSkillsFromSnapshot } from "@/application/skill/syncSkills";

export const GET = withAuth(async () => {
  return Response.json({
    configured: Boolean(config.skillsRepo && config.githubToken),
    repo: config.skillsRepo ?? null,
    branch: config.skillsRepoBranch,
  });
});

export const POST = withAuth(async () => {
  if (!config.skillsRepo || !config.githubToken) {
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
