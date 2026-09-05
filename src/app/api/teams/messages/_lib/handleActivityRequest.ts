import { teamsClient } from "@/infrastructure/teams/client";
import { openDocumentExtractor } from "@/application/execution/documentExtractor";
import { teamsActivityRepository } from "@/infrastructure/db/repositories/teamsActivityRepository";
import { transcriptRepository } from "@/infrastructure/db/repositories/transcriptRepository";
import {
  signArtifactUrl,
  executionDeps,
  projectRepository,
  versionRepository,
} from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { classifyTeamsActivity } from "@/application/teams/engagement";
import { handleTeamsActivity } from "@/application/teams/handleActivity";
import type { TeamsEventBinding } from "@/application/teams/projectTeams";
import type { TeamsActivity, TeamsEventDeps } from "@/application/teams/types";
import { admitInboundEvent, readEventBody } from "@/app/api/_lib/inboundEvent";
import { log } from "@/shared/logger";

const teamsEventDeps: TeamsEventDeps = {
  runAgent: (params) => executeAgent(executionDeps, params),
  projects: projectRepository,
  versions: versionRepository,
  teams: teamsClient,
  openDocuments: (version, signal, origin) => openDocumentExtractor(executionDeps, version, signal, origin),
  // Named even when this deployment has none, so "no object storage here" is a
  // source-level decision rather than omitted wiring.
  signFile: signArtifactUrl,
  transcripts: transcriptRepository,
};

/**
 * The Teams messaging pipeline: check the Bot Framework's token → gate →
 * exactly-once claim → ack immediately and process in the background. The Bot
 * Framework gives an endpoint fifteen seconds and then retries, so the ack is
 * what keeps a slow model from turning one question into several.
 *
 * The token is checked *against the activity*: it must have been issued for
 * the `serviceUrl` the activity names, because that is the address every reply
 * — with the app's own token attached — is sent to. Everything the endpoint
 * trusts rests on that check.
 */
export async function handleTeamsActivityRequest(
  request: Request,
  binding: TeamsEventBinding,
): Promise<Response> {
  const body = await readEventBody(request);
  if (body instanceof Response) {
    return body;
  }
  let activity: TeamsActivity;
  try {
    activity = JSON.parse(body) as TeamsActivity;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
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
      `project ${binding.projectName}: refused a request whose token did not verify (${verified.reason}, ${body.length} byte body)`,
    );
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  const disposition = classifyTeamsActivity(activity);
  if (disposition.kind === "ignore") {
    return new Response(null, { status: 200 });
  }

  const admitted = await admitInboundEvent({
    claims: teamsActivityRepository.forBot(binding.projectName, binding.credentials.appId),
    // An activity id is unique within its conversation and no further — two
    // chats can stamp the same millisecond — so the conversation qualifies it.
    eventId: activity.id ? `${activity.conversation?.id ?? ""}#${activity.id}` : undefined,
    scope: "teams",
    logLabel: `project ${binding.projectName}`,
    work: () => handleTeamsActivity(teamsEventDeps, disposition, binding),
  });
  // The Bot Framework wants a bare 200 (or 202); a body is not read.
  return new Response(null, { status: admitted === "duplicate" ? 200 : 202 });
}
