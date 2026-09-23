/** Bounds one user's favorite ids in their single preference row. */
export const MAX_FAVORITE_MODELS = 200;

/** Personal model choices, keyed by the stable Better Auth user id. */
export interface ModelPreferencesRepository {
  getFavoriteModels(userId: string): Promise<string[]>;
  replaceFavoriteModels(userId: string, modelIds: string[]): Promise<void>;
  changeFavoriteModels(userId: string, change: (modelIds: string[]) => string[]): Promise<string[]>;
}
