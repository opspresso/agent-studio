import { after } from "next/server";
import { executeFiring } from "@/application/trigger/runTrigger";
import {
  MAX_CONCURRENT_FIRINGS,
  driveFirings,
  scanSchedules,
  scheduleInput,
} from "@/application/trigger/scanSchedules";
import { organizationRepository, triggerRunnerDeps } from "@/lib/container";
import { DEFAULT_TENANT, withTenant } from "@/shared/tenantContext";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { unauthorized } from "@/shared/unauthorized";
import { withRunContext } from "@/shared/runContext";

/**
 * The scheduler tick. A Kubernetes CronJob (or anything able to POST once a
 * minute) calls this; which occurrences are due, who wins each one, and what
 * runs is all decided inside `scanSchedules` — the ticker holds no state and
 * needs no cron knowledge, so ticking twice, from two places, or late is safe.
 *
 * Authentication is a shared token, like the webhook secret but for the whole
 * endpoint: no session is involved, and a deployment without the token has no
 * ticker and answers 503 rather than scanning for whoever asks.
 *
 * Firings run in the background, exactly like webhook deliveries: the ticker's
 * request must return in seconds while runs take minutes, and each firing's
 * outcome goes on its history row.
 */
export async function POST(request: Request): Promise<Response> {
  const token = config.scheduleScanToken;
  if (!token) {
    return Response.json({ error: "Schedule scanning is not configured" }, { status: 503 });
  }
  const presented = request.headers.get("x-scan-token");
  if (!presented || !timingSafeEqualString(presented, token)) {
    // Worth a line: a ticker with a mangled token would otherwise 401 every
    // minute forever with no signal on either side.
    log.warn("trigger", "scan tick refused: wrong or missing token");
    return unauthorized();
  }

  // Every workspace, not just the default one: `listSchedules` reads the
  // current tenant's index, so a single scan would leave every other tenant's
  // schedules silently unfired. The ticker stays stateless — which tenants
  // exist is read here, per tick, rather than configured into it.
  const at = new Date();
  const tenants = [DEFAULT_TENANT, ...(await organizationRepository.list()).map((org) => org.id)];
  const scans = await Promise.all(
    tenants.map(async (tenant) => ({
      tenant,
      result: await withTenant(tenant, () => scanSchedules(triggerRunnerDeps, at)),
    })),
  );
  const summary = scans.reduce(
    (total, scan) => ({
      checked: total.checked + scan.result.summary.checked,
      fired: total.fired + scan.result.summary.fired,
      alreadyClaimed: total.alreadyClaimed + scan.result.summary.alreadyClaimed,
      skipped: total.skipped + scan.result.summary.skipped,
      repaired: total.repaired + scan.result.summary.repaired,
      invalid: total.invalid + scan.result.summary.invalid,
      errors: total.errors + scan.result.summary.errors,
    }),
    { checked: 0, fired: 0, alreadyClaimed: 0, skipped: 0, repaired: 0, invalid: 0, errors: 0 },
  );
  // The summary an operator alerts on lives in the log stream, not only in a
  // response body nobody keeps.
  log.info(
    "trigger",
    `scan: checked=${summary.checked} fired=${summary.fired} alreadyClaimed=${summary.alreadyClaimed}` +
      ` skipped=${summary.skipped} repaired=${summary.repaired} invalid=${summary.invalid}` +
      ` errors=${summary.errors}`,
  );
  after(() =>
    // Bounded, not one task per firing: a 09:00 shared by every project must
    // not become that many simultaneous runs on the pod that served the tick.
    // Each tenant's firings run in their own scope, because `after()` leaves the
    // request's async context and the run writes rows this tenant owns.
    Promise.all(
      scans.map((scan) =>
        withTenant(scan.tenant, () =>
          driveFirings(scan.result.firings, MAX_CONCURRENT_FIRINGS, (firing) =>
            // The firing's run id, for the same reason the webhook route opens
            // it: a log line and the history row share a key.
            withRunContext({ runId: firing.runId }, async () => {
              await executeFiring(triggerRunnerDeps, firing, scheduleInput(firing.trigger));
            }),
          ),
        ),
      ),
    ),
  );
  return Response.json(summary);
}
