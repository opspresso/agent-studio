import type { Agent } from "./types";

export interface AgentRepository {
  get(name: string, options?: { includeDeleting?: boolean }): Promise<Agent | null>;
  /** Agents ordered by name, strictly after `after` when supplied. */
  list(limit: number, after?: string): Promise<Agent[]>;
  create(agent: Agent): Promise<void>;
  update(agent: Agent, expectedUpdatedAt: string): Promise<void>;
  delete(name: string): Promise<void>;
}
