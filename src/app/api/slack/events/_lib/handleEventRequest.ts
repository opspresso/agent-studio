import { after } from "next/server";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import type {
  SlackBotBinding,
  SlackEventBody,
  SlackEventDeps,
} from "@/application/slack/handleSlackEvent";

const slackEventDeps: SlackEventDeps = {
  execution: executionDeps,
  projects: projectRepository,
  versions: versionRepository,
};

/**
 * Shared Slack Events pipeline: verify signature → url_verification →
 * event-type gate → exactly-once claim → ack immediately and process in the
 * background via `after()`. Slack requires an ack within 3 seconds; the
 * container runs as a persistent process, so background work survives the
 * response.
 */
export async function handleSlackEventRequest(
  request: Request,
  opts: { signingSecret: string; binding?: SlackBotBinding; logLabel: string },
): Promise<Response> {
  const body = await request.text();
  const verified = verifySlackSignature({
    signingSecret: opts.signingSecret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  });
  if (!verified) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(body) as SlackEventBody & { type?: string; challenge?: string };

  if (payload.type === "url_verification" && payload.challenge) {
    return Response.json({ challenge: payload.challenge });
  }

  const eventType = payload.event?.type;
  const isMention = eventType === "app_mention";
  const isDirectMessage = eventType === "message" && payload.event?.channel_type === "im";
  if (payload.type !== "event_callback" || (!isMention && !isDirectMessage)) {
    return Response.json({ ok: true });
  }

  if (payload.event_id && !(await slackEventRepository.claim(payload.event_id))) {
    return Response.json({ ok: true, duplicate: true });
  }

  after(async () => {
    try {
      await handleSlackEvent(slackEventDeps, payload, opts.binding);
    } catch (error) {
      console.error(`[slack] ${opts.logLabel} event handling failed`, error);
    }
  });

  return Response.json({ ok: true });
}
