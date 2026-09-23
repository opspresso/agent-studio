import type { ModelPreferencesRepository } from "@/domain/llm/modelPreferences";
import { keys } from "@/infrastructure/db/keys";
import { deleteItem, getItem, putItem, updateItem } from "@/infrastructure/db/store";

const ENTITY_TYPE = "MODEL_PREFERENCES" as const;
const favoriteModels = (item: Record<string, unknown> | null): string[] =>
  item && Array.isArray(item.favoriteModels)
    ? item.favoriteModels.filter((id): id is string => typeof id === "string")
    : [];

export const modelPreferencesRepository: ModelPreferencesRepository = {
  async getFavoriteModels(userId) {
    const item = await getItem(keys.modelPreferences(userId));
    return favoriteModels(item);
  },

  async replaceFavoriteModels(userId, modelIds) {
    const key = keys.modelPreferences(userId);
    if (modelIds.length === 0) {
      await deleteItem(key);
      return;
    }
    await putItem({ ...key, entityType: ENTITY_TYPE, favoriteModels: modelIds });
  },

  async changeFavoriteModels(userId, change) {
    const { after } = await updateItem(keys.modelPreferences(userId), item => ({
      entityType: ENTITY_TYPE,
      favoriteModels: change(favoriteModels(item)),
    }));
    return favoriteModels(after);
  },
};
