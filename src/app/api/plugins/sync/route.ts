import { z } from "zod";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { AppError, UpstreamError } from "@/application/errors";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { lastPluginSync, syncPluginsFromRepo } from "@/lib/container";

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
    // The last report survives the browser that ran the sync; a reload or a
    // proxy timeout must not lose the only copy of what happened.
    last: repo ? await lastPluginSync(repo) : null,
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
    // An error that already knows its status keeps it — a sync already
    // running is a 409, not an upstream fault. Only a bare Error is assumed
    // to be GitHub's: the fetch path is the one thing left that throws them.
    return apiError(
      error instanceof Error && !(error instanceof AppError)
        ? new UpstreamError(error.message)
        : error,
    );
  }
});
