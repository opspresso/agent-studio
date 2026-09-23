import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime, modelPreferenceUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import type { ModelConfig } from "@/domain/llm/models";

export interface AudioOptionsResponse {
  models: Array<ModelConfig & { favorite: boolean }>;
  destinations: string[];
}
export const GET = withMemberAuth(async (user, _request: Request, context: { params: Promise<{ name: string }> }) => {
  try {
    const { name } = await context.params;
    const [options, favoriteIds] = await Promise.all([
      getAudioRuntime().options(name, user.email),
      modelPreferenceUseCases.listOptional(user.id),
    ]);
    const favorites = new Set(favoriteIds);
    return Response.json({ ...options, models: options.models.map(model => ({ ...model, favorite: favorites.has(model.id) })) } satisfies AudioOptionsResponse);
  } catch (error) { return apiError(error); }
});
