import { ConflictError, isConditionalWriteFailure } from "@/application/errors";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";

/** Persist an optimistic agent update and give every agent slice the same conflict contract. */
export async function persistAgentUpdate(
  repo: AgentRepository,
  updated: Agent,
  expectedUpdatedAt: string,
): Promise<void> {
  try {
    await repo.update(updated, expectedUpdatedAt);
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Agent "${updated.name}" was modified by another request`);
    }
    throw error;
  }
}
