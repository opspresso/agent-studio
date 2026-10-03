import { after } from "next/server";
import { admitDelivery, executeDelivery } from "@/application/trigger/runTrigger";
import { triggerRunnerDeps } from "@/lib/container";
import { readEventBody } from "@/app/api/_lib/inboundEvent";
import { unauthorized } from "@/shared/unauthorized";
import { withRunContext } from "@/shared/runContext";
import { WEBHOOK_CREDENTIAL_QUERY } from "@/domain/trigger/types";

type RouteContext = { params: Promise<{ agent: string }> };

/**
 * An agent's webhook: `POST /api/webhook/{agent}`.
 *
 * Each agent has one shared webhook configuration. `admitDelivery` resolves
 * that row; personal credentials control which callers may execute it.
 *
 * Authentication selects a personal Webhook credential and its issuing Studio user.
 * GitHub callbacks include its public selector in the credential query parameter.
 *
 * It answers 202 and runs in the background. A run here can last ten minutes
 * and no webhook sender waits that long; the delivery's outcome goes on its
 * history row, which the console reads. An instance lost mid-delivery therefore
 * leaves a row stuck in `running`; `repairLostRuns` finishes it, driven both by
 * the schedule tick and by the next delivery this webhook takes, so a deployment
 * with no ticker configured is covered too.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { agent } = await ctx.params;
  // Bounded and refused by the same rule as every chat platform's webhook: a
  // payload larger than this is not a webhook event, it is a file upload.
  const body = await readEventBody(request);
  if (body instanceof Response) {
    return body;
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
    agent,
    // GitHub does not send X-Trigger-Secret. Its Secret field produces a body
    // signature. Presence of GitHub headers selects that scheme without a
    // fallback to a generic secret when a signature is invalid or missing.
    ["x-hub-signature-256", "x-hub-signature", "x-github-delivery", "x-github-event"].some(name => request.headers.has(name))
      ? { kind: "github", credentialId: new URL(request.url).searchParams.get(WEBHOOK_CREDENTIAL_QUERY), signature: request.headers.get("x-hub-signature-256"), body,
        deliveryId: request.headers.get("x-github-delivery"), event: request.headers.get("x-github-event") }
      : request.headers.get("x-trigger-secret"),
    request.headers.get("idempotency-key"),
  );

  switch (admitted.status) {
    case "unauthorized":
      // The shared shape — a webhook caller reads a 401 the same way a session
      // or token caller does.
      return unauthorized('Webhook realm="agent", headers="X-Trigger-Secret or X-Hub-Signature-256"');
    case "invalid-delivery":
      return Response.json({ error: "GitHub deliveries require a valid X-GitHub-Delivery and X-GitHub-Event" }, { status: 400 });
    case "ping":
      return Response.json({ ok: true, status: "ping" }, { status: 202 });
    case "ignored":
      return Response.json({ ok: true, status: "ignored", reason: admitted.reason }, { status: 202 });
    case "review-not-ready":
      return Response.json({ error: admitted.reason, status: admitted.status }, { status: 409 });
    case "not-configured":
      // Missing shared configuration is 404; invalid personal credentials are 401.
      return Response.json({ error: "Webhook not found" }, { status: 404 });
    case "duplicate":
      return Response.json({ ok: true, status: "duplicate" }, { status: 202 });
    case "busy":
      return Response.json({ ok: true, status: "busy" }, { status: 202 });
    case "no-configuration":
      return Response.json({ ok: true, status: "no-configuration" }, { status: 202 });
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
  return Response.json({ ok: true, status: "accepted", runId }, { status: 202 });
}
