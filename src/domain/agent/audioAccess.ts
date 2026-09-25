import type { Agent } from "./types";

export function agentHasAudioTools(agent: Pick<Agent, "configuration">): boolean {
  return agent.configuration?.parameters.audioProcessing === true;
}
