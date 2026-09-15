import { z } from "zod";
import { workspaceRepositoryPolicyUseCases } from "@/lib/container";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { isRepositoryName, isRepositoryOwner } from "@/domain/workspace/policy";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

const updateSchema = z.object({
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1).nullable(),
  rules: z.object({
    repository: z.string().trim().refine(isRepositoryName).optional(),
    repositories: z.array(z.string().trim().refine(isRepositoryName)).max(WORKSPACE_LIMITS.policyRepositories),
    repositoryOwners: z.array(z.string().trim().refine(isRepositoryOwner)).max(WORKSPACE_LIMITS.policyOwners),
  }).strict().nullable(),
}).strict();
type Context = { params: Promise<{ name: string }> };
export type WorkspacePolicyResponse = Awaited<ReturnType<typeof workspaceRepositoryPolicyUseCases.getView>>;

export const GET = withMemberAuth(async (user, _request: Request, context: Context) => {
  try { return Response.json(await workspaceRepositoryPolicyUseCases.getView(parseName((await context.params).name), user.email) satisfies WorkspacePolicyResponse); }
  catch (error) { return apiError(error); }
});

export const PUT = withAdminAuth(async (user, request: Request, context: Context) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json(await workspaceRepositoryPolicyUseCases.update(parseName((await context.params).name), parsed.data, user.email) satisfies WorkspacePolicyResponse); }
  catch (error) { return apiError(error); }
});
