import { after } from "next/server";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackClient } from "@/infrastructure/slack/client";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";
import type {
  SlackBotBinding,
  SlackEventBody,
  SlackEventDeps,
} from "@/application/slack/handleSlackEvent";
import { log } from "@/shared/logger";

const slackEventDeps: SlackEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  projects: projectRepository,
  versions: versionRepository,
  slack: slackClient,
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
  const verified = verifySlackSignature({
    signingSecret: opts.signingSecret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  });
  if (!verified) {
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
  if (payload.type !== "event_callback" || (!isMention && !isDirectMessage)) {
    return Response.json({ ok: true });
  }

  const eventId = payload.event_id;
  if (eventId) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!(await slackEventRepository.claim(eventId, nowSeconds, nowSeconds + RUN_LEASE_SECONDS))) {
      return Response.json({ ok: true, duplicate: true });
    }
  }

  after(async () => {
    let outcome: "done" | "failed" = "done";
    try {
      await handleSlackEvent(slackEventDeps, payload, opts.binding);
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
  });

  return Response.json({ ok: true });
}
