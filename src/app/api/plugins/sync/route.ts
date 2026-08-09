import { z } from "zod";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { UpstreamError } from "@/application/errors";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { syncPluginsFromRepo } from "@/lib/container";

/**
 * The repository's content applies automatically; deletion is the one act
 * that needs a person. These name what a previous report listed as orphaned —
 * kind-qualified, because the skills and MCP registries may hold one name.
 */
const selectionSchema = z.object({
  remove: z
    .object({
      skills: z.array(z.string()).max(500).optional(),
      mcpServers: z.array(z.string()).max(500).optional(),
      plugins: z.array(z.string()).max(500).optional(),
    })
    .optional(),
});

export const GET = withAuth(async () => {
  const { repo, branch, token } = await getPluginsRepoConfig();
  return Response.json({
    configured: Boolean(repo && token),
    repo: repo ?? null,
    branch,
  });
});

export const POST = withAdminAuth(async (user, request: Request) => {
  const repoConfig = await getPluginsRepoConfig();
  if (!repoConfig.repo || !repoConfig.token) {
    return Response.json(
      { error: "PLUGINS_REPO and GITHUB_TOKEN are not configured" },
      { status: 503 },
    );
  }
  const parsed = selectionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Invalid selection" }, { status: 400 });
  }
  try {
    return Response.json(await syncPluginsFromRepo(repoConfig, user.email, parsed.data));
  } catch (error) {
    // Through `apiError` like every other route. Deciding a status from a
    // substring of the message answered 500 for "PLUGINS_REPO is not
    // configured" — our fault, said about theirs.
    return apiError(
      error instanceof Error && !(error instanceof UpstreamError)
        ? new UpstreamError(error.message)
        : error,
    );
  }
});
