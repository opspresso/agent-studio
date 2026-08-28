import { after } from "next/server";
import { executeFiring } from "@/application/trigger/runTrigger";
import {
  MAX_CONCURRENT_FIRINGS,
  driveFirings,
  scanSchedules,
  scheduleInput,
} from "@/application/trigger/scanSchedules";
import { sweepExpiredRows, triggerRunnerDeps } from "@/lib/container";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { unauthorized } from "@/shared/unauthorized";
import { withRunContext } from "@/shared/runContext";

/**
 * The scheduler tick. A deployment-owned ticker (or anything able to POST once a
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

  const { summary, firings } = await scanSchedules(triggerRunnerDeps, new Date());
  // The summary an operator alerts on lives in the log stream, not only in a
  // response body nobody keeps.
  log.info(
    "trigger",
    `scan: checked=${summary.checked} fired=${summary.fired} alreadyClaimed=${summary.alreadyClaimed}` +
      ` skipped=${summary.skipped} repaired=${summary.repaired} invalid=${summary.invalid}` +
      ` errors=${summary.errors}`,
  );
  // Retention rides on the same tick: the one thing that already runs once a
  // minute on every deployment that has a ticker. Best-effort — a sweep that
  // fails leaves rows for the next tick, and must not fail the scan.
  after(() =>
    sweepExpiredRows().then(
      (swept) => {
        if (swept > 0) {
          log.info("trigger", `retention: swept ${swept} expired row(s)`);
        }
      },
      (error: unknown) => log.error("trigger", "retention sweep failed", error),
    ),
  );
  after(() =>
    // Bounded, not one task per firing: a 09:00 shared by every project must
    // not become that many simultaneous runs on the pod that served the tick.
    driveFirings(firings, MAX_CONCURRENT_FIRINGS, (firing) =>
      // The firing's run id, for the same reason the webhook route opens it: a
      // log line and the history row an operator is looking at share a key.
      withRunContext({ runId: firing.runId }, async () => {
        await executeFiring(triggerRunnerDeps, firing, scheduleInput(firing.trigger));
      }),
    ),
  );
  return Response.json(summary);
}
