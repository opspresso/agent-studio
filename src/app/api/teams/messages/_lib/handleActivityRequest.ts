import { teamsClient } from "@/infrastructure/teams/client";
import { teamsActivityRepository } from "@/infrastructure/db/repositories/teamsActivityRepository";
import { transcriptRepository } from "@/infrastructure/db/repositories/transcriptRepository";
import {
  signArtifactUrl,
  executionDeps,
  agentRepository,
} from "@/lib/container";
import { executeAgent } from "@/application/execution/runAgent";
import { classifyTeamsActivity } from "@/application/teams/engagement";
import { handleTeamsActivity } from "@/application/teams/handleActivity";
import type { TeamsEventBinding } from "@/application/teams/agentTeams";
import type { TeamsActivity, TeamsEventDeps } from "@/application/teams/types";
import { admitInboundEvent, readEventBody } from "@/app/api/_lib/inboundEvent";
import { log } from "@/shared/logger";
import { teamsActivitySchema } from "./activitySchema";

const teamsEventDeps: TeamsEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  authorizeExecutionGrant: executionDeps.authorizeExecutionGrant,
  agents: agentRepository,
  teams: teamsClient,
  documents: executionDeps.documents,
  artifacts: executionDeps.artifacts,
  fileHistory: transcriptRepository,
  // Named even when this deployment has none, so "no object storage here" is a
  // source-level decision rather than omitted wiring.
  signFile: signArtifactUrl,
  transcripts: transcriptRepository,
};

/**
 * Verify the token against the App ID and activity serviceUrl before gating
 * engagement and claiming a delivery lease. Replies use that authenticated
 * serviceUrl. Accepted work runs after the ack; failed or expired attempts
 * may be claimed again.
 */
export async function handleTeamsActivityRequest(
  request: Request,
  binding: TeamsEventBinding,
): Promise<Response> {
  const body = await readEventBody(request);
  if (body instanceof Response) {
    return body;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = teamsActivitySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Invalid Teams activity" }, { status: 400 });
  }
  const activity = parsed.data as TeamsActivity;
  const verified = await teamsClient.verifyRequest(request.headers.get("authorization"), {
    appId: binding.credentials.appId,
    serviceUrl: activity.serviceUrl ?? "",
  });
  if (!verified.ok) {
    // Logged, like the Slack and Telegram refusals: "the Bot Framework reached
    // us with a token we refused" and "it never reached us" must not look the
    // same from outside. The reason names the check that failed, never the token.
    log.warn(
      "teams",
      `agent ${binding.agentName}: refused a request whose token did not verify (${verified.reason}, ${body.length} byte body)`,
    );
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  const disposition = classifyTeamsActivity(activity);
  if (disposition.kind === "ignore") {
    return new Response(null, { status: 200 });
  }

  const admitted = await admitInboundEvent({
    claims: teamsActivityRepository.forBot(binding.agentName, binding.credentials.appId),
    // An activity id is unique within its conversation and no further — two
    // chats can stamp the same millisecond — so the conversation qualifies it.
    eventId: activity.id ? `${activity.conversation?.id ?? ""}#${activity.id}` : undefined,
    scope: "teams",
    logLabel: `agent ${binding.agentName}`,
    work: () => handleTeamsActivity(teamsEventDeps, disposition, binding),
  });
  // The Bot Framework wants a bare 200 (or 202); a body is not read.
  return new Response(null, { status: admitted === "duplicate" ? 200 : 202 });
}
