import type { Agent } from "@/domain/agent/types";
import type { ConfigurationDeps } from "./configurationUseCases";
import { putAgentConfiguration } from "./configurationUseCases";
import { assertAgentAccessible, createAgent } from "./agentUseCases";
import { log } from "@/shared/logger";

export type CloneAgentFlowDeps = ConfigurationDeps;
export interface CloneAgentInput {
  sourceName: string;
  name: string;
  displayName: string;
  userEmail: string;
}
export interface CloneAgentResult { agent: Agent; warning?: string }

/** Copy current settings while keeping credentials and membership with their owner. */
export function composeCloneAgent(deps: CloneAgentFlowDeps): (input: CloneAgentInput) => Promise<CloneAgentResult> {
  return async (input) => {
    const source = await assertAgentAccessible(deps.agents, input.sourceName, input.userEmail);
    const agent = await createAgent(deps.agents, {
      name: input.name, displayName: input.displayName, description: source.description,
      ownerEmail: input.userEmail, departmentCode: source.departmentCode, visibility: source.visibility,
    });
    if (!source.configuration) return { agent };
    try {
      await putAgentConfiguration(deps, agent.name, {
        ...source.configuration,
        mcpList: source.configuration.mcpList.map(({ headers: _headers, headerTarget: _target, ...binding }) => binding),
        expectedUpdatedAt: agent.updatedAt,
      }, input.userEmail);
      return { agent: (await deps.agents.get(agent.name))! };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      log.warn("agent", `configuration could not be copied to "${agent.name}"`, error);
      return { agent, warning: `The Agent configuration could not be copied (${reason}); configure the clone before running it.` };
    }
  };
}
