/**
 * Installing a model catalog by hand — what an administrator does where the
 * published one cannot be reached. The document is checked the way a refresh
 * would check it *before* it is stored, so an upload that is not a catalog is
 * refused at the door rather than logged away at the next tick; then the
 * registry is refreshed at once, since the stored document is what the
 * refresher reads first (`modelCatalogStoredSource.ts`).
 */

import type { ModelCatalogDocumentRepository } from "@/domain/llm/catalogDocument";
import { validateModelCatalog } from "@/domain/llm/models";
import { ValidationError } from "@/application/errors";

/** What the console shows about the stored document, and what `install` answers. */
export type ModelCatalogDocumentStatus =
  | { stored: false }
  | {
      stored: true;
      uploadedBy: string;
      uploadedAt: string;
      /** The catalog's own stamp — what the registry shows as "catalog updated". */
      updatedAt: string;
      /** Entries the registry installs from it. */
      modelCount: number;
      /** `id — reason`, one per entry the registry refuses. */
      skipped: string[];
    };

export interface ModelCatalogDocumentUseCases {
  status(): Promise<ModelCatalogDocumentStatus>;
  /**
   * Validate, store, refresh. `refreshed` is the refresher's answer — false
   * when the registry already held this upload, which the console reads
   * beside the status rather than as a failure.
   */
  install(
    document: unknown,
    actorEmail: string,
  ): Promise<ModelCatalogDocumentStatus & { refreshed: boolean }>;
  /**
   * Remove the document and refresh. The registry then follows the published
   * catalog on this refresh where one is read; without one it keeps the last
   * installed catalog until the process restarts into the snapshot — a
   * registry is never emptied, and the snapshot is not re-installable at
   * runtime on purpose (it is the floor, not a source).
   */
  remove(): Promise<{ stored: false; refreshed: boolean }>;
}

export function createModelCatalogDocumentUseCases(
  repository: ModelCatalogDocumentRepository,
  refresh: () => Promise<boolean>,
  now: () => Date = () => new Date(),
): ModelCatalogDocumentUseCases {
  async function status(): Promise<ModelCatalogDocumentStatus> {
    const record = await repository.get();
    if (record === null) {
      return { stored: false };
    }
    // Re-read rather than stored beside the document: a summary written at
    // upload time would describe the loader of that day, not this one.
    const summary = validateModelCatalog(record.document);
    return {
      stored: true,
      uploadedBy: record.uploadedBy,
      uploadedAt: record.uploadedAt,
      updatedAt: summary.updatedAt,
      modelCount: summary.models,
      skipped: summary.skipped,
    };
  }

  return {
    status,

    async install(document, actorEmail) {
      try {
        validateModelCatalog(document);
      } catch (error) {
        throw new ValidationError(
          `not a usable model catalog: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await repository.put({ document, uploadedBy: actorEmail, uploadedAt: now().toISOString() });
      const refreshed = await refresh();
      return { ...(await status()), refreshed };
    },

    async remove() {
      await repository.delete();
      const refreshed = await refresh();
      return { stored: false, refreshed };
    },
  };
}
