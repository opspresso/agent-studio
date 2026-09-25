import type { ModelConfig } from "@/domain/llm/models";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";
import { createAgent, type CreateAgentInput } from "./agentUseCases";
import { modelFitsAgent } from "./modelCompatibility";

export interface CreateAgentFlowDeps {
  agents: AgentRepository;
  offered(): Promise<ModelConfig[]>;
}

/** Create the Agent and its initial current settings in the same row. */
export function composeCreateAgent(deps: CreateAgentFlowDeps): (input: CreateAgentInput) => Promise<Agent> {
  return async (input) => {
    const model = (await deps.offered()).find(modelFitsAgent)?.id;
    return createAgent(deps.agents, {
      ...input,
      ...(model ? { configuration: {
        systemPrompt: "", model, parameters: { piiFiltering: false },
        mcpList: [], skillList: [], subagentList: [],
      } } : {}),
    });
  };
}
