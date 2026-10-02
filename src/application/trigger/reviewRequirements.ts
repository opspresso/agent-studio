import type { Agent } from "@/domain/agent/types";
import { WORKSPACE_TOOL_NAME } from "@/domain/llm/toolNames";

/** Shared setup checks for configuration, admission and the last execution boundary. */
export function reviewSetupIssue(
  agent: Pick<Agent, "configuration">,
): string | undefined {
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
