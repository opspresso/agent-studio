import { z } from "zod";
import { modelPreferenceUseCases, workspaceRuntimeModelUseCases } from "@/lib/container";
import { WORKSPACE_MODEL_RUNTIMES, type WorkspaceModelRuntime } from "@/domain/workspace/runtimeModels";
import type { ModelConfig } from "@/domain/llm/models";
import type { WorkspaceRuntimeModelsView } from "@/application/workspace/runtimeModels";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const schema = z.object({ runtime: z.enum(WORKSPACE_MODEL_RUNTIMES), model: z.string().min(1).max(200).nullable() }).strict();
export type WorkspaceRuntimeModelsResponse = Omit<WorkspaceRuntimeModelsView, "options"> & {
  options: Record<WorkspaceModelRuntime, Array<ModelConfig & { favorite: boolean }>>;
};

async function personalized(view: WorkspaceRuntimeModelsView, userId: string): Promise<WorkspaceRuntimeModelsResponse> {
  const favorites = new Set(await modelPreferenceUseCases.listOptional(userId));
  const options = {} as WorkspaceRuntimeModelsResponse["options"];
  for (const runtime of WORKSPACE_MODEL_RUNTIMES) {
    options[runtime] = view.options[runtime].map(model => ({ ...model, favorite: favorites.has(model.id) }));
  }
  return { ...view, options };
}

export const GET = withMemberAuth(async (user) => {
  try { return Response.json(await personalized(await workspaceRuntimeModelUseCases.getView(), user.id) satisfies WorkspaceRuntimeModelsResponse); }
  catch (error) { return apiError(error); }
});
export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json(await personalized(await workspaceRuntimeModelUseCases.select(parsed.data.runtime, parsed.data.model, user.email), user.id) satisfies WorkspaceRuntimeModelsResponse); }
  catch (error) { return apiError(error); }
});
