import { withMemberAuth } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import type { WorkspaceDetail } from "@/application/workspace/workspaceUseCases";

type Context = { params: Promise<{ id: string }> };
export type WorkspaceDetailResponse = WorkspaceDetail;
export const GET = withMemberAuth(async (user, request: Request, context: Context) => {
  try { return Response.json(await workspaceUseCases.get((await context.params).id, user.email, new URL(request.url).searchParams.get("tail") === "1") satisfies WorkspaceDetailResponse); }
  catch (error) { return apiError(error); }
});
export const DELETE = withMemberAuth(async (user, _request: Request, context: Context) => {
  try { await workspaceUseCases.close((await context.params).id, user.email); return new Response(null, { status: 204 }); }
  catch (error) { return apiError(error); }
});
