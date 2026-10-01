/**
 * Reading and removing what runs produced.
 *
 * The owner index includes outputs attributed to a resolved email, including
 * personal-context automation. The agent index also includes outputs without
 * a personal owner, and uses the agent's management access rules.
 */

import { NotFoundError, ValidationError } from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import {
  assertAgentOwnerOrAdminReadable,
  assertAgentWritable,
} from "@/application/agent/agentUseCases";
import type { AgentRepository } from "@/domain/agent/repository";
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
  readPrivateFile(artifactId: string, viewerEmail: string, maxBytes?: number): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
  listMine(email: string, options?: ListArtifactsOptions): Promise<Artifact[]>;
  listByAgent(
    agentName: string,
    viewerEmail: string,
    options?: ListArtifactsOptions,
  ): Promise<Artifact[]>;
  remove(artifactId: string, actorEmail: string): Promise<void>;
  /** Render supported MIME types under a fresh permission check and MAX_INLINE_VIEW_BYTES. */
  readForView(
    artifactId: string,
    viewerEmail: string,
  ): Promise<{ artifact: Artifact; bytes: Uint8Array; view: InlineView }>;
}

export function createArtifactUseCases(
  repo: ArtifactRepository,
  objects: ArtifactObjectStore,
  agents: AgentRepository,
  privateFiles?: {
    read(agent: string, file: string, email: string, maxBytes?: number): Promise<{ bytes: Uint8Array }>;
    remove(agent: string, file: string, email: string): Promise<void>;
  },
): ArtifactUseCases {
  /** Use the same resolved email expression as the owner index. */
  function isOwnRow(artifact: Artifact, email: string): boolean {
    return artifactOwnerEmail(artifact.actor, artifact.ownerEmail) === email;
  }

  /**
   * Who may remove this. Falls through to the agent's own write rule, which
   * admits the owner and an admin — and records the override when it is an
   * admin reaching in.
   */
  async function assertMayManage(artifact: Artifact, actorEmail: string): Promise<void> {
    if (isOwnRow(artifact, actorEmail)) {
      return;
    }
    await assertAgentWritable(agents, artifact.agentName, actorEmail);
  }

  /** Ordinary Artifact reads admit the creator or Agent manager without a write-override audit. */
  async function assertMayRead(artifact: Artifact, viewerEmail: string): Promise<void> {
    if (isOwnRow(artifact, viewerEmail)) {
      return;
    }
    await assertAgentOwnerOrAdminReadable(agents, artifact.agentName, viewerEmail);
  }

  return {
    async readPrivateFile(artifactId, viewerEmail, maxBytes) {
      const artifact = await repo.get(artifactId);
      if (!artifact?.privateFileId || !privateFiles || !isOwnRow(artifact, viewerEmail)) {
        throw new NotFoundError("Private artifact not found");
      }
      const { bytes } = await privateFiles.read(artifact.agentName, artifact.privateFileId, viewerEmail, maxBytes);
      return { artifact, bytes };
    },
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
      if (artifact.privateFileId && (!privateFiles || !isOwnRow(artifact, viewerEmail))) throw new NotFoundError("Private artifact not found");
      const { bytes } = artifact.privateFileId
        ? await privateFiles!.read(artifact.agentName, artifact.privateFileId, viewerEmail, MAX_INLINE_VIEW_BYTES)
        : await objects.read(artifact.key, MAX_INLINE_VIEW_BYTES);
      return { artifact, bytes, view };
    },

    async listMine(email, options = {}) {
      return repo.listByOwner(email, bounded(options));
    },

    async listByAgent(agentName, viewerEmail, options = {}) {
      await assertAgentOwnerOrAdminReadable(agents, agentName, viewerEmail);
      return repo.listByAgent(agentName, bounded(options));
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
      if (artifact.privateFileId) {
        if (!privateFiles || !isOwnRow(artifact, actorEmail)) throw new NotFoundError("Private artifact not found");
        await privateFiles.remove(artifact.agentName, artifact.privateFileId, actorEmail);
      } else await objects.delete(artifact.key);
      await repo.delete(artifact.artifactId);
      // Only when it was not the person's own. A gallery tidy-up recorded row by
      // row would bury the trail this table exists for; reaching into someone
      // else's output is the act worth keeping.
      if (!isOwnRow(artifact, actorEmail)) {
        await recordAudit({
          actorEmail,
          action: "artifact.delete",
          target: auditTarget("artifact", artifactId),
          detail: `${artifact.kind} in agent ${artifact.agentName}`,
        });
      }
    },
  };
}

function bounded(options: ListArtifactsOptions): ListArtifactsOptions {
  const limit = boundedPageLimit(options.limit ?? DEFAULT_ARTIFACT_PAGE, MAX_ARTIFACT_PAGE);
  return { ...options, limit };
}
