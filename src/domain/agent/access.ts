import type { Agent } from "./types";

export type AgentAccessFields = Pick<Agent, "ownerEmail" | "visibility">;

/** Public is the default catalog visibility. */
export function isAgentPrivate(agent: AgentAccessFields): boolean {
  return agent.visibility === "private";
}

/** Agent management belongs to its creator, independently of installation roles. */
export function isAgentOwner(agent: Pick<Agent, "ownerEmail">, email: string): boolean {
  return agent.ownerEmail.toLowerCase() === email.toLowerCase();
}

/** Visibility never grants access to another person's private Agent, including admins. */
export function mayAccessAgent(agent: AgentAccessFields, email: string): boolean {
  return !isAgentPrivate(agent) || isAgentOwner(agent, email);
}
