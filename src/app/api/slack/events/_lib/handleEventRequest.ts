import { after } from "next/server";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackClient } from "@/infrastructure/slack/client";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import { handleThreadStart } from "@/application/slack/handleThreadStart";
import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import { withRunContext } from "@/shared/runContext";
import type { SlackBotBinding } from "@/application/slack/handleSlackEvent";
import type { SlackEventBody, SlackEventDeps } from "@/application/slack/types";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";

const slackEventDeps: SlackEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  projects: projectRepository,
  versions: versionRepository,
  slack: slackClient,
  loadingIndicator: config.slackLoadingIndicator,
};

const MAX_SLACK_BODY_BYTES = 1_000_000;

/**
 * Shared Slack Events pipeline: verify signature → url_verification →
 * event-type gate → exactly-once claim → ack immediately and process in the
 * background via `after()`. Slack requires an ack within 3 seconds; the
 * container runs as a persistent process, so background work survives the
 * response.
 */
export async function handleSlackEventRequest(
  request: Request,
  opts: { signingSecret: string; binding: SlackBotBinding; logLabel: string },
): Promise<Response> {
  let body: string;
  try {
    body = await readBodyText(request, MAX_SLACK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: "Request body too large" }, { status: 413 });
    }
    throw error;
  }
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  const verified = verifySlackSignature({
    signingSecret: opts.signingSecret,
    body,
    timestamp,
    signature,
  });
  if (!verified) {
    // A refusal used to be silent, which left the two states an operator has to
    // tell apart — "Slack reached us and the signature was wrong" and "Slack
    // never reached us" — looking identical from the outside: no log either way.
    // Setting up a Request URL is exactly when that distinction is needed.
    //
    // The signature and the secret are never logged; what is logged is the
    // shape of the failure, which is what narrows it: missing headers point at
    // something that is not Slack, a large skew at the clock, and neither of
    // those at the wrong signing secret being stored for this project.
    const skew = timestamp ? Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) : null;
    log.warn(
      "slack",
      `${opts.logLabel}: refused a request whose signature did not verify ` +
        `(timestamp ${timestamp ? `present, ${skew}s skew` : "missing"}, ` +
        `signature ${signature ? "present" : "missing"}, ${body.length} byte body)`,
    );
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: SlackEventBody & { type?: string; challenge?: string };
  try {
    payload = JSON.parse(body) as SlackEventBody & { type?: string; challenge?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (payload.type === "url_verification" && payload.challenge) {
    return Response.json({ challenge: payload.challenge });
  }

  const eventType = payload.event?.type;
  const isMention = eventType === "app_mention";
  const isDirectMessage = eventType === "message" && payload.event?.channel_type === "im";
  /**
   * A user opening the agent. The agent messaging experience announces it with
   * `app_home_opened` on the Messages tab (the Home tab is a different surface
   * and is not ours); the legacy assistant view uses `assistant_thread_started`.
   * Both are answered with prompts rather than a run.
   */
  const isThreadStart =
    (eventType === "app_home_opened" && payload.event?.tab === "messages") ||
    eventType === "assistant_thread_started";
  if (payload.type !== "event_callback" || (!isMention && !isDirectMessage && !isThreadStart)) {
    return Response.json({ ok: true });
  }

  const eventId = payload.event_id;
  if (eventId) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!(await slackEventRepository.claim(eventId, nowSeconds, nowSeconds + RUN_LEASE_SECONDS))) {
      return Response.json({ ok: true, duplicate: true });
    }
  }

  // Same reason as the webhook path: `after()` leaves the request's async
  // context. The Slack event id is the natural key — it is what the dedup claim
  // is keyed by, so a log line joins the row that says whether it was handled.
  after(() =>
    withRunContext({ runId: eventId ?? "slack-event" }, async () => {
      let outcome: "done" | "failed" = "done";
      try {
        await (isThreadStart
          ? handleThreadStart(slackEventDeps, payload, opts.binding)
          : handleSlackEvent(slackEventDeps, payload, opts.binding));
      } catch (error) {
        outcome = "failed";
        log.error("slack", `${opts.logLabel} event handling failed`, error);
      }
      if (!eventId) {
        return;
      }
      // Settling is bookkeeping for a response that already went out; a failure
      // here leaves the claim to expire on its own rather than escalating.
      try {
        await slackEventRepository.settle(eventId, outcome);
      } catch (error) {
        log.error("slack", `${opts.logLabel} event settle failed`, error);
      }
    }),
  );

  return Response.json({ ok: true });
}
