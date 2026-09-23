import {
  getVisibleModels,
  listModelMakers,
  modelCatalogUpdatedAt,
  modelType,
  type ModelConfig,
  type ModelType,
} from "@/domain/llm/models";
import { modelPreferenceUseCases } from "@/lib/container";
import {
  getEmbeddingModelSelection,
  getLlmProviderConfigs,
  getRerankerModelSelection,
  getRerankerMinScoreSelection,
  type ModelSelection,
  type ScoreSelection,
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
  rerankerMinScore: ScoreSelection;
  selectionAvailable: { embedding: boolean; rerank: boolean };
}

/** Runtime facts, user favorites and active retrieval selections for the model usage console. */
export const GET = withMemberAuth(async (user) => {
  const [
    providerConfigs,
    favoriteModels,
    embedding,
    rerank,
    rerankerMinScore,
  ] = await Promise.all([
    getLlmProviderConfigs(),
    modelPreferenceUseCases.list(user.id),
    getEmbeddingModelSelection(),
    getRerankerModelSelection(),
    getRerankerMinScoreSelection(),
  ]);
  const dedicated = new Set(providerConfigs.map((provider) => provider.name));
  const favorites = new Set(favoriteModels);
  return Response.json({
    providers: providerConfigs.map(({ name }) => ({
      name,
      available: true,
      dedicated: dedicated.has(name),
    })),
    models: getVisibleModels().map((model) => ({
      ...model,
      type: modelType(model),
      selectionHidden: !dedicated.has(model.provider),
      favorite: favorites.has(model.id),
    })),
    makers: listModelMakers(),
    updatedAt: modelCatalogUpdatedAt(),
    source: "override",
    selections: { embedding, ...(rerank ? { rerank } : {}) },
    rerankerMinScore,
    selectionAvailable: {
      embedding: config.catalogEnabled,
      rerank: config.catalogEnabled,
    },
  } satisfies ModelsCatalogResponse);
});
