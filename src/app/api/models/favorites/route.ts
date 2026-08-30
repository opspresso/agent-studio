import { z } from "zod";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";
import { modelPreferenceUseCases } from "@/lib/container";
import { MAX_FAVORITE_MODELS } from "@/domain/llm/modelPreferences";
import { withAuth } from "@/lib/session";

const updateSchema = z.object({
  models: z.array(z.string().min(1).max(200)).max(MAX_FAVORITE_MODELS),
});

export interface ModelFavoritesResponse {
  models: string[];
}

export const GET = withAuth(async (user) => {
  return Response.json({
    models: await modelPreferenceUseCases.list(user.id),
  } satisfies ModelFavoritesResponse);
});

export const PUT = withAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json({
      models: await modelPreferenceUseCases.replace(user.id, parsed.data.models),
    } satisfies ModelFavoritesResponse);
  } catch (error) {
    return apiError(error);
  }
});
