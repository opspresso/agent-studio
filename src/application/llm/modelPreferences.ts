import { ValidationError } from "@/application/errors";
import { getModelConfig } from "@/domain/llm/models";
import {
  MAX_FAVORITE_MODELS,
  type ModelPreferencesRepository,
} from "@/domain/llm/modelPreferences";

export interface ModelPreferenceUseCases {
  list(userId: string): Promise<string[]>;
  replace(userId: string, modelIds: string[]): Promise<string[]>;
}

export function createModelPreferenceUseCases(
  repository: ModelPreferencesRepository,
): ModelPreferenceUseCases {
  return {
    list(userId) {
      return repository.getFavoriteModels(userId);
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
  };
}
