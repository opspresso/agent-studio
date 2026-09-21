import { offeredModels, type ModelConfig } from "@/domain/llm/models";
import { modelPreferenceUseCases } from "@/lib/container";
import { getLlmProviderConfigs, getDefaultModel } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

export type SelectableModel = ModelConfig & { favorite: boolean };

export interface ModelsResponse {
  models: SelectableModel[];
}

/** Administrator-selected execution models with registered connections, default first. */
export const GET = withAuth(async (user) => {
  const [providerConfigs, favoriteModels, defaultModel] = await Promise.all([
    getLlmProviderConfigs(),
    modelPreferenceUseCases.list(user.id),
    getDefaultModel(),
  ]);
  const favorites = new Set(favoriteModels);
  const models = offeredModels(
    providerConfigs.map((provider) => provider.name),
    undefined,
    undefined,
    defaultModel,
  ).map((model) => ({ ...model, favorite: favorites.has(model.id) }));
  return Response.json({ models } satisfies ModelsResponse);
});
