/**
 * Reading and removing what runs produced.
 *
 * Listing has two entry points because the rows have two reachable axes and
 * neither covers the other: a person's own gallery (the owner index) misses
 * every Slack, A2A and trigger run, whose actor names no mailbox, and a
 * project's gallery is how those are reached — but projects are a shared
 * catalog, so it is not a substitute for the personal one either.
 */

import { NotFoundError, ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import type { ProjectRepository } from "@/domain/project/repository";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ArtifactRepository, ListArtifactsOptions } from "@/domain/artifact/repository";
import {
  artifactOwnerEmail,
  isInlineViewable,
  MAX_INLINE_VIEW_BYTES,
} from "@/domain/artifact/types";
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
  /**
   * The bytes behind one artifact, for the single reader that renders them
   * instead of handing out an address.
   *
   * Every other read is a signed URL: the object answers, and this app never
   * holds the bytes. A page that runs in a browser cannot be served that way —
   * an address it could be opened at is an address it could be *forwarded* at,
   * outliving the rights of whoever opened it, and in public mode it would be
   * permanent. So the one case that renders comes back through here, where the
   * same predicate that guards a delete still applies.
   */
  readForView(
    artifactId: string,
    viewerEmail: string,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
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
    async readForView(artifactId, viewerEmail) {
      const artifact = await repo.get(artifactId);
      if (!artifact) {
        throw new NotFoundError(`Artifact not found: ${artifactId}`);
      }
      await assertMayManage(artifact, viewerEmail);
      // The type is checked before the bytes are fetched, not after: a ten-megabyte
      // deck read into memory to then be refused is the same refusal at a cost.
      if (!isInlineViewable(artifact.mimeType)) {
        throw new ValidationError(`${artifact.mimeType} is downloaded rather than viewed`);
      }
      const { bytes } = await objects.read(artifact.key, MAX_INLINE_VIEW_BYTES);
      return { artifact, bytes };
    },

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
