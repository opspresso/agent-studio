import { withMemberAuth } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { workspaceInputSchema } from "../../_schemas";
import { workspaceRunView, type WorkspaceRunView } from "@/application/workspace/workspaceUseCases";

type Context = { params: Promise<{ id: string }> };
export interface WorkspaceRunResponse { run: WorkspaceRunView }
export const POST = withMemberAuth(async (user, request: Request, context: Context) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = workspaceInputSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json({ run: workspaceRunView(await workspaceUseCases.enqueue((await context.params).id, user.email, parsed.data, request.headers.get("idempotency-key") ?? "")) } satisfies WorkspaceRunResponse, { status: 202 }); }
  catch (error) { return apiError(error); }
});
export const DELETE = withMemberAuth(async (user, _request: Request, context: Context) => {
  try { await workspaceUseCases.cancel((await context.params).id, user.email); return new Response(null, { status: 204 }); }
  catch (error) { return apiError(error); }
});
