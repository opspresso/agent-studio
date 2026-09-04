import {
  getVisibleModels,
  listModelMakers,
  modelCatalogUpdatedAt,
  modelType,
  providerOffered,
  SUPPORTED_PROVIDERS,
  type ModelConfig,
  type ModelType,
} from "@/domain/llm/models";
import { modelPreferenceUseCases } from "@/lib/container";
import {
  getEmbeddingModelSelection,
  getHiddenModels,
  getLlmProviderConfigs,
  getRerankerModelSelection,
  type ModelSelection,
} from "@/lib/runtime-settings";
import { withMemberAuth } from "@/lib/session";
import { config } from "@/lib/config";

export interface ModelsCatalogResponse {
  providers: Array<{ name: string; available: boolean; dedicated: boolean }>;
  models: Array<ModelConfig & { type: ModelType; selectionHidden: boolean; favorite: boolean }>;
  makers: Record<string, string>;
  updatedAt: string;
  source: "override" | "default";
  selections: { embedding: ModelSelection; rerank?: ModelSelection };
  selectionAvailable: { embedding: boolean; rerank: boolean };
}

/**
 * GET /api/models/catalog — the /models console's full picture: every visible
 * model with its operator-hidden and personal-favorite flags, and which
 * providers this deployment can dispatch to. Read from the member rung, like the other registries the
 * Intelligence section lists: it names what this deployment can reach,
 * including the models an admin hid — which a member may see but
 * not pick, since `/api/models` still hides them from the pickers. Changing
 * the hidden list stays admin's (`PUT /api/settings`), as does the probe.
 *
 * `makers` and `updatedAt` come with the models because they are the
 * catalog's, loaded at runtime: a client cannot import them from a constant
 * that no longer exists.
 */
export const GET = withMemberAuth(async (user) => {
  const [
    providerConfigs,
    hiddenModels,
    favoriteModels,
    embedding,
    rerank,
  ] = await Promise.all([
    getLlmProviderConfigs(),
    getHiddenModels(),
    modelPreferenceUseCases.list(user.id),
    getEmbeddingModelSelection(),
    getRerankerModelSelection(),
  ]);
  const dedicated = new Set(providerConfigs.map((provider) => provider.name));
  const hidden = new Set(hiddenModels ?? []);
  const favorites = new Set(favoriteModels);
  return Response.json({
    providers: SUPPORTED_PROVIDERS.map((name) => ({
      name,
      available: providerOffered(name, dedicated),
      dedicated: dedicated.has(name),
    })),
    models: getVisibleModels().map((model) => ({
      ...model,
      type: modelType(model),
      selectionHidden: hidden.has(model.id),
      favorite: favorites.has(model.id),
    })),
    makers: listModelMakers(),
    updatedAt: modelCatalogUpdatedAt(),
    source: hiddenModels === undefined ? "default" : "override",
    selections: { embedding, ...(rerank ? { rerank } : {}) },
    selectionAvailable: {
      embedding: config.catalogEnabled,
      rerank: config.catalogEnabled && config.reranker !== undefined,
    },
  } satisfies ModelsCatalogResponse);
});
