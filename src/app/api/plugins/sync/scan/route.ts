import { after } from "next/server";
import { lastPluginSync, pluginsRepoHeadSha, syncPluginsFromRepo } from "@/lib/container";
import { getPluginsRepoConfig } from "@/lib/runtime-settings";
import { reportHasFailures } from "@/domain/plugin/sync";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { unauthorized } from "@/shared/unauthorized";
import { isArchiveSync } from "@/domain/plugin/sync";

/**
 * The plugins-sync tick. A Kubernetes CronJob (or anything able to POST)
 * calls this so a merge to the plugins repo lands without waiting for an
 * admin to visit the console. Authentication is the same shared token the
 * schedule scan uses — one CronJob credential per deployment — and ticking
 * twice is safe: the sync lease turns the second tick into a no-op.
 *
 * The sync runs in the background, like schedule firings: the tick returns
 * in milliseconds while GitHub reads take seconds. Its outcome lands in the
 * persisted report (`GET /api/plugins/sync`) and the log line below; a tick
 * never deletes anything — removal selections exist only in the console.
 */
export async function POST(request: Request): Promise<Response> {
  const token = config.scheduleScanToken;
  if (!token) {
    return Response.json({ error: "Scan ticking is not configured" }, { status: 503 });
  }
  const presented = request.headers.get("x-scan-token");
  if (!presented || !timingSafeEqualString(presented, token)) {
    log.warn("plugins", "sync tick refused: wrong or missing token");
    return unauthorized();
  }
  const repoConfig = await getPluginsRepoConfig();
  if (!repoConfig.repo || !repoConfig.token) {
    return Response.json({ error: "PLUGINS_REPO and GITHUB_TOKEN are not configured" }, { status: 503 });
  }

  // A minute-by-minute tick must not pay for a full snapshot when nothing
  // moved: one head read against ~30 blob reads. A report carrying a fenced
  // write failure disqualifies the shortcut — only a re-run repairs it.
  try {
    const [head, last] = await Promise.all([
      pluginsRepoHeadSha(repoConfig),
      lastPluginSync(repoConfig.repo),
    ]);
    // An uploaded archive is a person's decision, and it stands: its commit
    // is the archive's digest, which no GitHub head will ever equal, so the
    // tick would otherwise replace the upload within the minute. A sync run
    // on purpose (`POST /api/plugins/sync`) is how GitHub takes over again.
    if (last && isArchiveSync(last.report.commitSha)) {
      return Response.json({ started: false, held: "archive" });
    }
    if (last && head === last.report.commitSha && !reportHasFailures(last.report)) {
      return Response.json({ started: false, upToDate: true });
    }
  } catch (error) {
    // The check is an optimization; if GitHub is unreachable the sync below
    // fails with the real error in the log.
    log.warn("plugins", "sync tick head check failed; running the full sync", error);
  }

  after(async () => {
    try {
      const result = await syncPluginsFromRepo(repoConfig, "scheduler");
      const totals = result.plugins.reduce(
        (sum, section) => {
          for (const kind of [section.skills, section.mcpServers]) {
            sum.created += kind.created.length;
            sum.overwritten += kind.overwritten.length;
            sum.skipped += kind.skipped.length;
          }
          return sum;
        },
        { created: 0, overwritten: 0, skipped: result.skipped.length },
      );
      log.info(
        "plugins",
        `sync tick: created=${totals.created} overwritten=${totals.overwritten} skipped=${totals.skipped}`,
      );
    } catch (error) {
      // A held lease is the ordinary overlap case, not a fault worth an error line.
      log.warn("plugins", "sync tick did not run", error);
    }
  });
  return Response.json({ started: true }, { status: 202 });
}
