import type { Agent, AgentApiToken } from "./types";

export interface AgentRepository {
  get(name: string, options?: { includeDeleting?: boolean }): Promise<Agent | null>;
  /** Agents ordered by name, strictly after `after` when supplied. */
  list(limit: number, after?: string): Promise<Agent[]>;
  create(agent: Agent): Promise<void>;
  update(agent: Agent, expectedUpdatedAt: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Read the agent's API token record (hash + createdAt), or null if none. */
  getApiToken(name: string): Promise<AgentApiToken | null>;
  /** Create or replace the agent's API token record (regeneration overwrites). */
  setApiToken(name: string, token: AgentApiToken): Promise<void>;
  /** Remove the agent's API token record. */
  deleteApiToken(name: string): Promise<void>;
}
