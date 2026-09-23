import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { getDecisionModelSelection } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

export interface DecisionModelResponse { model: string | null }

export const GET = withAdminAuth(async () => Response.json({
  model: (await getDecisionModelSelection())?.model ?? null,
} satisfies DecisionModelResponse));

export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = z.object({ model: z.string().min(1).max(200).nullable() }).safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    await modelRegistryUseCases.selectDecision(parsed.data.model, user.email);
    return Response.json({ model: parsed.data.model } satisfies DecisionModelResponse);
  } catch (error) { return apiError(error); }
});
