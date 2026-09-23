import { ValidationError } from "@/application/errors";
import { getModelConfig } from "@/domain/llm/models";
import { log } from "@/shared/logger";
import {
  MAX_FAVORITE_MODELS,
  type ModelPreferencesRepository,
} from "@/domain/llm/modelPreferences";

export interface ModelPreferenceUseCases {
  list(userId: string): Promise<string[]>;
  listOptional(userId: string): Promise<string[]>;
  replace(userId: string, modelIds: string[]): Promise<string[]>;
  setFavorite(userId: string, modelId: string, favorite: boolean): Promise<string[]>;
}

export function createModelPreferenceUseCases(
  repository: ModelPreferencesRepository,
): ModelPreferenceUseCases {
  return {
    list(userId) {
      return repository.getFavoriteModels(userId);
    },

    async listOptional(userId) {
      try {
        return await repository.getFavoriteModels(userId);
      } catch (error) {
        // A failed personal decoration must not block an otherwise available model list.
        log.warn("models", "model favorites unavailable for selection options", error);
        return [];
      }
    },

    async replace(userId, modelIds) {
      const ids = [...new Set(modelIds.map((id) => id.trim()))].sort();
      if (ids.length > MAX_FAVORITE_MODELS) {
        throw new ValidationError(`At most ${MAX_FAVORITE_MODELS} models may be favorited`);
      }
      const unknown = ids.filter((id) => {
        const model = getModelConfig(id);
        return model === undefined || model.hidden === true;
      });
      if (unknown.length > 0) {
        throw new ValidationError(`Unknown or retired model ids: ${unknown.join(", ")}`);
      }
      await repository.replaceFavoriteModels(userId, ids);
      return ids;
    },

    async setFavorite(userId, modelId, favorite) {
      const id = modelId.trim();
      const model = getModelConfig(id);
      if (favorite && (model === undefined || model.hidden === true)) {
        throw new ValidationError(`Unknown or retired model id: ${id}`);
      }
      return repository.changeFavoriteModels(userId, current => {
        const ids = new Set(current);
        if (favorite) ids.add(id); else ids.delete(id);
        if (ids.size > MAX_FAVORITE_MODELS) {
          throw new ValidationError(`At most ${MAX_FAVORITE_MODELS} models may be favorited`);
        }
        return [...ids].sort();
      });
    },
  };
}
