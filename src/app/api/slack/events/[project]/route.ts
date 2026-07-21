import { after } from "next/server";
import { projectRepository } from "@/lib/container";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import type { SlackEventBody } from "@/application/slack/handleSlackEvent";

type RouteContext = { params: Promise<{ project: string }> };

/**
 * Per-project Slack Events endpoint. Each project-dedicated bot points its
 * Events API request URL here; the signature is verified with that project's
 * own signing secret, so routing is unambiguous. Authentication IS the
 * signature — no session is involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { project: projectName } = await ctx.params;
  const project = await projectRepository.get(projectName);
  const runtime = project ? resolveProjectSlackRuntime(project) : null;
  if (!project || !runtime) {
    return Response.json({ error: "Slack is not configured for this project" }, { status: 404 });
  }

  const body = await request.text();
  const verified = verifySlackSignature({
    signingSecret: runtime.signingSecret,
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
      await handleSlackEvent(payload, {
        projectName: project.name,
        botToken: runtime.botToken,
      });
    } catch (error) {
      console.error(`[slack] project event handling failed (${project.name})`, error);
    }
  });

  return Response.json({ ok: true });
}
