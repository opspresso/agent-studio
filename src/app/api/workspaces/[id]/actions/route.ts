import { withMemberAuth } from "@/lib/session";
import { getCodingUseCases } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { codingActionSchema } from "../../_schemas";
import type { CodingApproval } from "@/domain/coding/types";

export interface CodingApprovalResponse { approval: CodingApproval }
export const POST = withMemberAuth(async (user, request: Request, context: { params: Promise<{ id: string }> }) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = codingActionSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try { return Response.json({ approval: await getCodingUseCases().request((await context.params).id, user.email, parsed.data) } satisfies CodingApprovalResponse); }
  catch (error) { return apiError(error); }
});
