import { after } from "next/server";
import { executeFiring } from "@/application/trigger/runTrigger";
import { scanSchedules, scheduleInput } from "@/application/trigger/scanSchedules";
import { triggerRunnerDeps } from "@/lib/container";
import { config } from "@/lib/config";
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
    return unauthorized();
  }

  const { summary, firings } = await scanSchedules(triggerRunnerDeps, new Date());
  for (const firing of firings) {
    // The firing's run id, for the same reason the webhook route opens it: a
    // log line and the history row an operator is looking at share a key.
    const runId = firing.runId;
    after(() =>
      withRunContext({ runId }, async () => {
        await executeFiring(triggerRunnerDeps, firing, scheduleInput(firing.trigger));
      }),
    );
  }
  return Response.json(summary);
}
