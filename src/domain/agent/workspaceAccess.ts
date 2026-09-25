import type { Agent } from "./types";

export function agentHasWorkspaceTools(agent: Pick<Agent, "configuration">): boolean {
  return agent.configuration?.parameters.workspaceTools === true;
}
