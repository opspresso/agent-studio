import { z } from "zod";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { UpstreamError } from "@/application/errors";
import { getToolsRepoConfig } from "@/lib/runtime-settings";
import { syncToolsFromRepo } from "@/lib/container";

/**
 * A sync never overwrites or deletes on its own. These name what a previous
 * report said, once a person has looked at it.
 */
const selectionSchema = z.object({
  overwrite: z.array(z.string()).max(500).optional(),
  remove: z.array(z.string()).max(500).optional(),
});

export const GET = withAuth(async () => {
  const { repo, branch, token } = await getToolsRepoConfig();
  return Response.json({
    configured: Boolean(repo && token),
    repo: repo ?? null,
    branch,
  });
});

export const POST = withAdminAuth(async (user, request: Request) => {
  const repoConfig = await getToolsRepoConfig();
  if (!repoConfig.repo || !repoConfig.token) {
    return Response.json(
      { error: "TOOLS_REPO and GITHUB_TOKEN are not configured" },
      { status: 503 },
    );
  }
  const parsed = selectionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Invalid selection" }, { status: 400 });
  }
  try {
    return Response.json(await syncToolsFromRepo(repoConfig, parsed.data, user.email));
  } catch (error) {
    // Through `apiError` like every other route. Deciding a status from a
    // substring of the message answered 500 for "TOOLS_REPO is not configured"
    // — our fault, said about theirs.
    return apiError(
      error instanceof Error && !(error instanceof UpstreamError)
        ? new UpstreamError(error.message)
        : error,
    );
  }
});
