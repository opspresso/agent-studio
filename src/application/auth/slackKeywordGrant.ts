import type { SlackKeywordExecutionGrant } from "@/domain/execution/actor";
import { ForbiddenError } from "@/application/errors";
import { resolveAgentCaller, type RunUserDeps } from "./resolveRunUser";

/** Recheck registration and current account before models, tools and queued Workspace effects. */
export async function assertSlackKeywordExecutionGrant(deps: RunUserDeps, grant: SlackKeywordExecutionGrant): Promise<void> {
  const { agent, user } = await resolveAgentCaller(deps, grant.agentName, grant.userId);
  const slack = agent.slack;
  if (!slack?.enabled || !slack.channelKeywords?.length || slack.keywordExecution?.userId !== grant.userId ||
    slack.keywordExecution.revision !== grant.revision || user.email !== grant.email) {
    throw new ForbiddenError("The Slack channel-keyword execution permission changed");
  }
}
