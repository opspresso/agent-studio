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
import {
  assertProjectOutputReadable,
  assertProjectWritable,
} from "@/application/project/projectUseCases";
import type { ProjectRepository } from "@/domain/project/repository";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ArtifactRepository, ListArtifactsOptions } from "@/domain/artifact/repository";
import {
  artifactOwnerEmail,
  inlineViewOf,
  MAX_INLINE_VIEW_BYTES,
} from "@/domain/artifact/types";
import type { Artifact, InlineView } from "@/domain/artifact/types";
import { boundedPageLimit } from "@/shared/pageLimit";

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
   *
   * `view` comes back with the bytes rather than being re-derived at the route:
   * whether a page is served as it was written or rendered from text is the
   * same decision as whether it may be viewed at all, and asking twice is how
   * the two answers drift.
   */
  readForView(
    artifactId: string,
    viewerEmail: string,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array; view: InlineView }>;
}

export function createArtifactUseCases(
  repo: ArtifactRepository,
  objects: ArtifactObjectStore,
  projects: ProjectRepository,
): ArtifactUseCases {
  /**
   * Whose gallery this row is in — **the same expression the owner index is
   * written with**, `ownerEmail` included.
   *
   * That argument is not optional detail: `DynamoArtifactRepository.put` files
   * the row under `artifactOwnerEmail(actor, ownerEmail)`, and `ownerEmail`
   * exists precisely for the surfaces whose actor names no mailbox. Asking
   * without it, a report a person got from the Slack or Telegram bot listed in
   * their own gallery and then answered 403 to every button on it — the row
   * filed under their address, the check saying it belonged to nobody.
   */
  function isOwnRow(artifact: Artifact, email: string): boolean {
    return artifactOwnerEmail(artifact.actor, artifact.ownerEmail) === email;
  }

  /**
   * Who may remove this. Falls through to the project's own write rule, which
   * admits the owner and an admin — and records the override when it is an
   * admin reaching in.
   */
  async function assertMayManage(artifact: Artifact, actorEmail: string): Promise<void> {
    if (isOwnRow(artifact, actorEmail)) {
      return;
    }
    await assertProjectWritable(projects, artifact.projectName, actorEmail);
  }

  /**
   * Who may look at this. The *read* sibling, and not the same call as above on
   * purpose: `assertProjectWritable` writes a `project.admin-override` audit row
   * and a warn line every time it admits an admin, which is the right record for
   * a delete and the wrong one for a GET behind a link. An admin opening ten
   * artifacts in a gallery would have written ten rows claiming a write
   * override, burying the trail that table exists for under read traffic —
   * which `remove` already avoids for a person's own deletes for the same
   * reason.
   *
   * `assertProjectOutputReadable` is the same rule with nothing recorded — not
   * `assertProjectAccessible`, which admits everyone a *public* project admits.
   * A project's outputs are not public because the project is: two people
   * running the same shared project each produced their own, and the project
   * gallery already asks the stricter question to list them.
   */
  async function assertMayRead(artifact: Artifact, viewerEmail: string): Promise<void> {
    if (isOwnRow(artifact, viewerEmail)) {
      return;
    }
    await assertProjectOutputReadable(projects, artifact.projectName, viewerEmail);
  }

  return {
    async readForView(artifactId, viewerEmail) {
      const artifact = await repo.get(artifactId);
      if (!artifact) {
        throw new NotFoundError(`Artifact not found: ${artifactId}`);
      }
      await assertMayRead(artifact, viewerEmail);
      // The type is checked before the bytes are fetched, not after: a ten-megabyte
      // deck read into memory to then be refused is the same refusal at a cost.
      const view = inlineViewOf(artifact.mimeType);
      if (!view) {
        throw new ValidationError(`${artifact.mimeType} is downloaded rather than viewed`);
      }
      // The row already knows its size, so the same refusal is spent here rather
      // than as a transport error from the adapter's own cap — which arrives
      // untyped and reaches the reader as a 500 saying nothing, after a round
      // trip that was never going to be used.
      if (artifact.byteSize > MAX_INLINE_VIEW_BYTES) {
        throw new ValidationError(
          `That file is too large to open here; download it instead (${artifact.byteSize} bytes).`,
        );
      }
      const { bytes } = await objects.read(artifact.key, MAX_INLINE_VIEW_BYTES);
      return { artifact, bytes, view };
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
      if (!isOwnRow(artifact, actorEmail)) {
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
  const limit = boundedPageLimit(options.limit ?? DEFAULT_ARTIFACT_PAGE, MAX_ARTIFACT_PAGE);
  return { ...options, limit };
}
