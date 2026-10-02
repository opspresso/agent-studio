import type { Agent } from "./types";

export type AgentAccessFields = Pick<Agent, "ownerEmail" | "visibility">;

/** Public is the default catalog visibility. */
export function isAgentPrivate(agent: AgentAccessFields): boolean {
  return agent.visibility === "private";
}

/** Visibility never grants access to another person's private Agent, including admins. */
export function mayAccessAgent(agent: AgentAccessFields, email: string): boolean {
  return !isAgentPrivate(agent) || agent.ownerEmail.toLowerCase() === email.toLowerCase();
}
