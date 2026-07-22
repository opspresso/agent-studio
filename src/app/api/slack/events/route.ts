import { after } from "next/server";
import { getSlackSigningSecret } from "@/lib/runtime-settings";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import type { SlackEventBody } from "@/application/slack/handleSlackEvent";

/**
 * Slack Events API endpoint. Slack requires an ack within 3 seconds, so the
 * event is verified, claimed for dedup, acked immediately, and processed in
 * the background via `after()` (the container runs as a persistent process,
 * so background work survives the response).
 */
export async function POST(request: Request): Promise<Response> {
  const signingSecret = await getSlackSigningSecret();
  if (!signingSecret) {
    return Response.json({ error: "Slack is not configured" }, { status: 503 });
  }

  const body = await request.text();
  const verified = verifySlackSignature({
    signingSecret,
    body,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
  });
  if (!verified) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(body) as SlackEventBody & {
    type?: string;
    challenge?: string;
  };

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
      await handleSlackEvent(payload);
    } catch (error) {
      console.error("[slack] event handling failed", error);
    }
  });

  return Response.json({ ok: true });
}
