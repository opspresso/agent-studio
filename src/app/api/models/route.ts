import { offeredModels, type ModelConfig } from "@/domain/llm/models";
import { modelPreferenceUseCases } from "@/lib/container";
import { getHiddenModels, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

export type SelectableModel = ModelConfig & { favorite: boolean };

export interface ModelsResponse {
  models: SelectableModel[];
}

/**
 * GET /api/models — the models this deployment offers for selection. The rule
 * (visible × configured providers − hidden-model denylist) is
 * `offeredModels` in the domain; this route only feeds it the runtime
 * settings.
 */
export const GET = withAuth(async (user) => {
  const [providerConfigs, hiddenModels, favoriteModels] = await Promise.all([
    getLlmProviderConfigs(),
    getHiddenModels(),
    modelPreferenceUseCases.list(user.id),
  ]);
  const favorites = new Set(favoriteModels);
  const models = offeredModels(
    providerConfigs.map((provider) => provider.name),
    hiddenModels,
  ).map((model) => ({ ...model, favorite: favorites.has(model.id) }));
  return Response.json({ models } satisfies ModelsResponse);
});
