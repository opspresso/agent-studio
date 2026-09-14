import { withMemberAuth } from "@/lib/session";
import { getCodingUseCases } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { codingDecisionSchema } from "../../../_schemas";
import type { CodingApprovalResponse } from "../route";

export const POST = withMemberAuth(async (user, request: Request, context: { params: Promise<{ id: string; action: string }> }) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = codingDecisionSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { const { id, action } = await context.params;
    return Response.json({ approval: await getCodingUseCases().decide(id, user.email, action, parsed.data.approve) } satisfies CodingApprovalResponse);
  } catch (error) { return apiError(error); }
});
