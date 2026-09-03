import { ConflictError, ValidationError } from "@/application/errors";
import type { ReindexReport } from "@/application/catalog/reindexCatalog";
import { getModelConfig, modelType } from "@/domain/llm/models";
import {
  CATALOG_REINDEX_LEASE_MS,
  type CatalogReindexLock,
} from "@/domain/catalog/reindexLock";
import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  SettingsUseCases,
  SettingsView,
} from "@/application/settings/settingsUseCases";

export type GlobalModelType = "embedding" | "rerank";

export interface ModelSelectionResult {
  settings: SettingsView;
  migration?: ReindexReport;
}

export interface ModelSelectionDeps {
  repository: SettingsRepository;
  lock: CatalogReindexLock;
  settings: SettingsUseCases;
  current(type: GlobalModelType): Promise<string | undefined>;
  available(type: GlobalModelType): boolean;
  hidden(): Promise<string[] | undefined>;
  testReranker?: (model: string) => Promise<void>;
  invalidate(): void;
  reindex?: () => Promise<ReindexReport>;
}

export interface ModelSelectionUseCases {
  select(
    type: GlobalModelType,
    model: string,
    migrate: boolean,
    actorEmail: string,
  ): Promise<ModelSelectionResult>;
}

export function createModelSelectionUseCases(
  deps: ModelSelectionDeps,
): ModelSelectionUseCases {
  return {
    async select(type, model, migrate, actorEmail) {
      const selected = getModelConfig(model);
      if (!selected) {
        throw new ValidationError(`Unknown model "${model}"`);
      }
      if (modelType(selected) !== type) {
        throw new ValidationError(
          `Model "${model}" is not ${type === "embedding" ? "an" : "a"} ${type} model`,
        );
      }
      if (selected.hidden === true || (await deps.hidden())?.includes(model)) {
        throw new ValidationError(`Model "${model}" is hidden from selection`);
      }
      if (!deps.available(type)) {
        throw new ValidationError(`The ${type} endpoint is not configured`);
      }
      if (model === await deps.current(type)) {
        return { settings: await deps.settings.getView() };
      }
      if (type === "rerank") {
        if (!deps.testReranker) {
          throw new ValidationError("The reranker endpoint is not configured");
        }
        await deps.testReranker(model);
        const settings = await deps.settings.update({ rerankerModel: model }, actorEmail);
        deps.invalidate();
        return { settings };
      }
      if (!migrate) {
        throw new ValidationError("Changing the embedding model requires migration approval");
      }
      if (!deps.reindex) {
        throw new ValidationError("The capability catalog is not enabled");
      }
      const lease = await deps.lock.acquire(CATALOG_REINDEX_LEASE_MS);
      if (!lease) {
        throw new ConflictError("An embedding migration is already running");
      }
      try {
        const before = await deps.repository.get();
        const settings = await deps.settings.update({ embeddingModel: model }, actorEmail);
        deps.invalidate();
        try {
          return { settings, migration: await deps.reindex() };
        } catch (migrationError) {
          try {
            await deps.settings.update(
              { embeddingModel: before?.embeddingModel ?? "" },
              actorEmail,
            );
          } catch (restoreSelectionError) {
            throw new Error(
              `Embedding migration failed and the previous selection could not be restored: ${restoreSelectionError instanceof Error ? restoreSelectionError.message : String(restoreSelectionError)}`,
              { cause: migrationError },
            );
          }
          deps.invalidate();
          try {
            await deps.reindex();
          } catch (rollbackError) {
            throw new Error(
              `Embedding migration failed and the previous index could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              { cause: migrationError },
            );
          }
          throw migrationError;
        }
      } finally {
        await deps.lock.release(lease);
      }
    },
  };
}
