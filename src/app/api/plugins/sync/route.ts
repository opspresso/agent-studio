import { z } from "zod";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { UpstreamError } from "@/application/errors";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { syncPluginsFromRepo } from "@/lib/container";

/**
 * A sync never overwrites or deletes on its own. These name what a previous
 * report said, once a person has looked at it — kind-qualified, because the
 * skills and MCP registries may hold the same name.
 */
const kindSelection = z.object({
  skills: z.array(z.string()).max(500).optional(),
  mcpServers: z.array(z.string()).max(500).optional(),
});
const selectionSchema = z.object({
  overwrite: kindSelection.optional(),
  remove: kindSelection
    .extend({ plugins: z.array(z.string()).max(500).optional() })
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
