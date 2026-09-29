import type { Agent } from "@/domain/agent/types";
import type { WebhookTrigger } from "@/domain/trigger/types";
import { WORKSPACE_TOOL_NAME } from "@/domain/llm/toolNames";

/** Shared setup checks for configuration, admission and the last execution boundary. */
export function reviewSetupIssue(
  trigger: Pick<WebhookTrigger, "executionEmail">,
  agent: Pick<Agent, "ownerEmail" | "configuration">,
): string | undefined {
  if (!trigger.executionEmail || trigger.executionEmail !== agent.ownerEmail) {
    return 'PR review requires the Agent owner to enable "Run with my permissions" in Webhook settings.';
  }
  const parameters = agent.configuration?.parameters;
  if (!parameters?.workspaceTools) {
    return "PR review requires enabled Workspace tools in the Agent settings.";
  }
  if (parameters.policy?.blockedTools?.includes(WORKSPACE_TOOL_NAME) ||
      parameters.policy?.approvalTools?.includes(WORKSPACE_TOOL_NAME)) {
    return "Automatic PR review requires Workspace tools without a block or interactive tool approval.";
  }
  return undefined;
}
