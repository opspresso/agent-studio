/**
 * Reading and removing what runs produced.
 *
 * Listing has two entry points because the rows have two reachable axes and
 * neither covers the other: a person's own gallery (the owner index) misses
 * every Slack, A2A and trigger run, whose actor names no mailbox, and a
 * project's gallery is how those are reached — but projects are a shared
 * catalog, so it is not a substitute for the personal one either.
 */

import { NotFoundError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import type { ProjectRepository } from "@/domain/project/repository";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ArtifactRepository, ListArtifactsOptions } from "@/domain/artifact/repository";
import { artifactOwnerEmail } from "@/domain/artifact/types";
import type { Artifact } from "@/domain/artifact/types";

/** How many artifacts one page may carry. A gallery page, not a bulk export. */
export const MAX_ARTIFACT_PAGE = 100;
export const DEFAULT_ARTIFACT_PAGE = 24;

export interface ArtifactUseCases {
  listMine(email: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  listByProject(
    projectName: string,
    viewerEmail: string,
    options?: ListArtifactsOptions,
  ): Promise<Artifact[]>;
  remove(artifactId: string, actorEmail: string): Promise<void>;
}

export function createArtifactUseCases(
  repo: ArtifactRepository,
  objects: ArtifactObjectStore,
  projects: ProjectRepository,
): ArtifactUseCases {
  /**
   * Who may see or remove this. One predicate for both, deliberately: a
   * different rule for each produces a gallery listing rows whose delete button
   * answers 403.
   */
  async function assertMayManage(artifact: Artifact, viewerEmail: string): Promise<void> {
    if (artifactOwnerEmail(artifact.actor) === viewerEmail) {
      return;
    }
    // Falls through to the project's own rule, which admits the owner and an
    // admin — and records the override when it is an admin reaching in.
    await assertProjectWritable(projects, artifact.projectName, viewerEmail);
  }

  return {
    async listMine(email, options = {}) {
      return repo.listByOwner(email, bounded(options));
    },

    async listByProject(projectName, viewerEmail, options = {}) {
      await assertProjectWritable(projects, projectName, viewerEmail);
      return repo.listByProject(projectName, bounded(options));
    },

    async remove(artifactId, actorEmail) {
      const artifact = await repo.get(artifactId);
      if (!artifact) {
        throw new NotFoundError(`Artifact not found: ${artifactId}`);
      }
      await assertMayManage(artifact, actorEmail);
      // Object first: this order can only leave a row whose preview is broken,
      // which pressing delete again resolves, while the reverse leaves bytes no
      // inventory names — and nothing can find those to remove them later.
      await objects.delete(artifact.key);
      await repo.delete(artifactId);
      // Only when it was not the person's own. A gallery tidy-up recorded row by
      // row would bury the trail this table exists for; reaching into someone
      // else's output is the act worth keeping.
      if (artifactOwnerEmail(artifact.actor) !== actorEmail) {
        await recordAudit({
          actorEmail,
          action: "artifact.delete",
          target: auditTarget("artifact", artifactId),
          detail: `${artifact.kind} in project ${artifact.projectName}`,
        });
      }
    },
  };
}

function bounded(options: ListArtifactsOptions): ListArtifactsOptions {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_ARTIFACT_PAGE, 1), MAX_ARTIFACT_PAGE);
  return { ...options, limit };
}
