import { modelRegistryUseCases } from "@/lib/container";
import { withAuth, withAdminAuth } from "@/lib/session";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { modelRoutingPolicySchema } from "./schema";
import type { ModelRoutingView } from "@/application/llm/modelRegistry";

export type ModelRoutingResponse = ModelRoutingView;

export const GET = withAuth(async () => Response.json(await modelRegistryUseCases.getRouting() satisfies ModelRoutingResponse));
export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = modelRoutingPolicySchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json(await modelRegistryUseCases.saveRouting(parsed.data.policy, user.email) satisfies ModelRoutingResponse); }
  catch (error) { return apiError(error); }
});
