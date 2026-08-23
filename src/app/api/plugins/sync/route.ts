import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { AppError, UpstreamError } from "@/application/errors";
import { archiveSyncRepo } from "@/domain/plugin/sync";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { lastPluginSync, syncPluginsFromRepo } from "@/lib/container";
import { selectionSchema } from "./_lib/selection";

export const GET = withMemberAuth(async () => {
  const { repo, branch, token } = await getPluginsRepoConfig();
  return Response.json({
    configured: Boolean(repo && token),
    repo: repo ?? null,
    branch,
    // The last report survives the browser that ran the sync; a reload or a
    // proxy timeout must not lose the only copy of what happened. Read under
    // the name an archive upload would use, which is the configured repo when
    // there is one — so a deployment syncing by upload alone still sees it.
    last: await lastPluginSync(archiveSyncRepo(repo)),
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
