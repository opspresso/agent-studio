import { z } from "zod";
import { workspaceRuntimeModelUseCases } from "@/lib/container";
import { WORKSPACE_MODEL_RUNTIMES } from "@/domain/workspace/runtimeModels";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const schema = z.object({ runtime: z.enum(WORKSPACE_MODEL_RUNTIMES), model: z.string().min(1).max(200).nullable() }).strict();
export type WorkspaceRuntimeModelsResponse = Awaited<ReturnType<typeof workspaceRuntimeModelUseCases.getView>>;
export const GET = withMemberAuth(async () => {
  try { return Response.json(await workspaceRuntimeModelUseCases.getView() satisfies WorkspaceRuntimeModelsResponse); }
  catch (error) { return apiError(error); }
});
export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json(await workspaceRuntimeModelUseCases.select(parsed.data.runtime, parsed.data.model, user.email) satisfies WorkspaceRuntimeModelsResponse); }
  catch (error) { return apiError(error); }
});
