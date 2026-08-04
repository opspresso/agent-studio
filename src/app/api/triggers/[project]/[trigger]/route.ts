import { after } from "next/server";
import { admitDelivery, executeDelivery } from "@/application/trigger/runTrigger";
import { triggerRunnerDeps } from "@/lib/container";
import { readBodyText, BodyTooLargeError } from "@/shared/httpBody";
import { unauthorized } from "@/shared/unauthorized";
import { withRunContext } from "@/shared/runContext";

type RouteContext = { params: Promise<{ project: string; trigger: string }> };

/** A payload larger than this is not a webhook event, it is a file upload. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Webhook delivery endpoint. Authentication IS the trigger's secret — no
 * session is involved, exactly like the Slack endpoint's signature.
 *
 * It answers 202 and runs in the background. A run here can last ten minutes
 * and no webhook sender waits that long; the delivery's outcome goes on its
 * history row, which the console reads. An instance lost mid-delivery therefore
 * leaves a row stuck in `running`; `repairLostRuns` finishes it, driven both by
 * the schedule tick and by the next delivery this trigger takes, so a deployment
 * with no ticker configured is covered too.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { project, trigger } = await ctx.params;
  let body: string;
  try {
    body = await readBodyText(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: "Request body too large" }, { status: 413 });
    }
    throw error;
  }
  let payload: unknown;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const admitted = await admitDelivery(
    triggerRunnerDeps,
    project,
    trigger,
    request.headers.get("x-trigger-secret"),
    request.headers.get("idempotency-key"),
  );

  switch (admitted.status) {
    case "unauthorized":
      // The shared shape — a webhook caller reads a 401 the same way a session
      // or token caller does.
      return unauthorized();
    case "not-configured":
      // Deliberately the same answer a wrong secret would get for a trigger
      // that does exist would not be — but an unknown project/trigger is not a
      // secret, and 404 is what a misconfigured URL needs to say.
      return Response.json({ error: "Trigger not found" }, { status: 404 });
    case "disabled":
      return Response.json({ ok: true, status: "disabled" }, { status: 202 });
    case "duplicate":
      return Response.json({ ok: true, status: "duplicate" }, { status: 202 });
    case "busy":
      return Response.json({ ok: true, status: "busy" }, { status: 202 });
    case "no-published-version":
      return Response.json({ ok: true, status: "no-published-version" }, { status: 202 });
    case "accepted":
      break;
  }

  // The delivery id, not a fresh one: it is what the history row and the console
  // show, so a log line and the delivery an operator is looking at share a key.
  // Opened here because `after()` runs outside the request's async context, and
  // the run bracket's `enterWith` does not survive the generator delegation
  // between here and it.
  const runId = admitted.runId;
  after(() =>
    withRunContext({ runId }, async () => {
      await executeDelivery(triggerRunnerDeps, admitted, payload);
    }),
  );
  return Response.json({ ok: true, status: "accepted", runId: admitted.runId }, { status: 202 });
}
