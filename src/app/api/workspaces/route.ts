import { withMemberAuth } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { startWorkspaceSchema } from "./_schemas";
import type { StartWorkspaceResult } from "@/application/workspace/workspaceUseCases";

export type StartWorkspaceResponse = StartWorkspaceResult;

export const POST = withMemberAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = startWorkspaceSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const result = await workspaceUseCases.start(parsed.data, user.email, request.headers.get("idempotency-key") ?? "");
    return Response.json(result satisfies StartWorkspaceResponse, { status: 202 });
  } catch (error) { return apiError(error); }
});
