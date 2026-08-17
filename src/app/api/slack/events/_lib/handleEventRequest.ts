import { verifySlackSignature } from "@/infrastructure/slack/verify";
import { slackClient } from "@/infrastructure/slack/client";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { slackEventRepository } from "@/infrastructure/db/repositories/slackEventRepository";
import { slackThreadRepository } from "@/infrastructure/db/repositories/slackThreadRepository";
import {
  artifactStorage,
  executionDeps,
  projectRepository,
  versionRepository,
} from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import { handleThreadStart } from "@/application/slack/handleThreadStart";
import { classifySlackEvent, type EngagementPolicy } from "@/application/slack/engagement";
import { admitInboundEvent, readEventBody } from "@/app/api/_lib/inboundEvent";
import type { SlackBotBinding } from "@/application/slack/handleSlackEvent";
import type { SlackEventBody, SlackEventDeps } from "@/application/slack/types";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";

const slackEventDeps: SlackEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  projects: projectRepository,
  versions: versionRepository,
  slack: slackClient,
  threads: slackThreadRepository,
  documents: documentExtractor,
  // Named even when this deployment has none, so "no object storage here" is a
  // decision in the source rather than a field nobody thought about.
  ...(artifactStorage ? { signFile: artifactStorage.objects.sign } : {}),
  loadingIndicator: config.slackLoadingIndicator,
};

const MAX_SLACK_BODY_BYTES = 1_000_000;

/**
 * Shared Slack Events pipeline: verify signature → url_verification →
 * engagement gate → exactly-once claim → ack immediately and process in the
 * background (`admitInboundEvent`, the tail every chat platform's webhook
 * shares). Slack requires an ack within 3 seconds; the container runs as a
 * persistent process, so background work survives the response.
 *
 * **The gate is ahead of the claim, and that is a cost contract.** The bot
 * receives every message in every channel it belongs to, and the great majority
 * are not for it; deciding that before the claim is what keeps an ignored
 * message from writing a DynamoDB row. `classifySlackEvent` owns the decision
 * and spends nothing — the one branch that needs storage says so by returning
 * `engagedThread`, and only a threaded message can reach it.
 */
export async function handleSlackEventRequest(
  request: Request,
  opts: {
    signingSecret: string;
    binding: SlackBotBinding;
    logLabel: string;
    /** What this project asked to be woken by, beyond a mention. */
    engagement?: EngagementPolicy;
  },
): Promise<Response> {
  const body = await readEventBody(request, MAX_SLACK_BODY_BYTES);
  if (body instanceof Response) {
    return body;
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

  let payload: SlackEventBody & { challenge?: string };
  try {
    payload = JSON.parse(body) as SlackEventBody & { challenge?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (payload.type === "url_verification" && payload.challenge) {
    return Response.json({ challenge: payload.challenge });
  }

  const disposition = classifySlackEvent(payload, opts.engagement ?? {});
  if (disposition.kind === "ignore") {
    return Response.json({ ok: true });
  }
  // The one branch that costs a read. It is spent here rather than inside the
  // handler because the answer decides whether this is work at all — past the
  // claim below, an unengaged thread would already have cost a write.
  if (disposition.kind === "engagedThread") {
    const engaged = await slackThreadRepository
      .isEngaged(opts.binding.projectName, disposition.channel, disposition.threadTs)
      // A lookup that failed must not answer a message nobody addressed. The
      // cost of being wrong here is one unanswered follow-up; the cost the
      // other way is the bot speaking uninvited in a channel.
      .catch((error) => {
        log.error("slack", `${opts.logLabel} engagement lookup failed`, error);
        return false;
      });
    if (!engaged) {
      return Response.json({ ok: true });
    }
  }
  const isThreadStart = disposition.kind === "threadStart";

  const admitted = await admitInboundEvent({
    claims: slackEventRepository,
    eventId: payload.event_id,
    scope: "slack",
    logLabel: opts.logLabel,
    work: () =>
      isThreadStart
        ? handleThreadStart(slackEventDeps, payload, opts.binding)
        : handleSlackEvent(slackEventDeps, payload, opts.binding),
  });
  if (admitted === "duplicate") {
    return Response.json({ ok: true, duplicate: true });
  }
  return Response.json({ ok: true });
}
