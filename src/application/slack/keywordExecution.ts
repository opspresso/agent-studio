import type { SlackKeywordExecutionGrant } from "@/domain/execution/actor";
import { ForbiddenError } from "@/application/errors";
import { resolveAgentCaller, type RunUserDeps } from "@/application/auth/resolveRunUser";
import type { SlackEventBody } from "./types";
import { classifySlackEvent, matchesSlackChannelKeywords } from "./engagement";

/** App alerts have no human sender; their authority is the explicitly saved automation account. */
export async function authorizeSlackKeywordEvent(
  deps: RunUserDeps, agentName: string, body: SlackEventBody,
): Promise<SlackKeywordExecutionGrant> {
  const agent = await deps.agents.get(agentName);
  const registration = agent?.slack?.keywordExecution;
  if (!agent?.slack?.enabled || !registration) {
    throw new ForbiddenError("Save the channel keywords in Studio to authorize app alerts with your account.");
  }
  const disposition = classifySlackEvent(body, { keywords: agent.slack.channelKeywords });
  if (!body.team_id || !body.event?.bot_id || body.event.thread_ts || body.event.channel_type === "im" ||
    disposition.kind !== "run" || !matchesSlackChannelKeywords(body.event, agent.slack.channelKeywords)) {
    throw new ForbiddenError("This app message is not authorized by the channel keywords.");
  }
  const { user } = await resolveAgentCaller(deps, agentName, registration.userId);
  return { ...user, kind: "slack", source: "channel-keyword", agentName, realm: body.team_id,
    externalId: body.event.bot_id, revision: registration.revision };
}
