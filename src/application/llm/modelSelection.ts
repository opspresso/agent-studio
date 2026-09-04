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
import { log } from "@/shared/logger";

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
  currentRerankerMinScore(): Promise<number>;
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
    rerankerMinScore?: number,
  ): Promise<ModelSelectionResult>;
}

export function createModelSelectionUseCases(
  deps: ModelSelectionDeps,
): ModelSelectionUseCases {
  return {
    async select(type, model, migrate, actorEmail, rerankerMinScore) {
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
      const currentModel = await deps.current(type);
      if (type === "rerank") {
        if (
          rerankerMinScore !== undefined &&
          (!Number.isFinite(rerankerMinScore) || rerankerMinScore < 0 || rerankerMinScore > 1)
        ) {
          throw new ValidationError("Reranker minimum score must be between 0 and 1");
        }
        const scoreChanged =
          rerankerMinScore !== undefined &&
          rerankerMinScore !== await deps.currentRerankerMinScore();
        if (model === currentModel && !scoreChanged) {
          return { settings: await deps.settings.getView() };
        }
        if (!deps.testReranker) {
          throw new ValidationError("The reranker endpoint is not configured");
        }
        if (model !== currentModel) {
          await deps.testReranker(model);
        }
        const settings = await deps.settings.update(
          {
            rerankerModel: model,
            ...(rerankerMinScore !== undefined
              ? { rerankerMinScore: String(rerankerMinScore) }
              : {}),
          },
          actorEmail,
        );
        deps.invalidate();
        return { settings };
      }
      if (rerankerMinScore !== undefined) {
        throw new ValidationError("Reranker minimum score applies only to rerank models");
      }
      if (model === currentModel) {
        return { settings: await deps.settings.getView() };
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
        try {
          await deps.lock.release(lease);
        } catch (error) {
          // The lease expires on its own. Cleanup failure must not turn an
          // already committed selection/index into a client-visible failure,
          // or replace the migration error that led here.
          log.error("catalog", "embedding migration lease could not be released", error);
        }
      }
    },
  };
}
