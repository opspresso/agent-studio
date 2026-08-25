import { ConflictError, isConditionalWriteFailure } from "@/application/errors";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project } from "@/domain/project/types";

/** Persist an optimistic project update and give every project slice the same conflict contract. */
export async function persistProjectUpdate(
  repo: ProjectRepository,
  updated: Project,
  expectedUpdatedAt: string,
): Promise<void> {
  try {
    await repo.update(updated, expectedUpdatedAt);
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${updated.name}" was modified by another request`);
    }
    throw error;
  }
}
