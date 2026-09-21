import { z } from "zod";
import { modelRegistryUseCases } from "@/lib/container";
import { getDefaultModel } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

export interface DefaultModelResponse { model: string | null }
export const GET = withAdminAuth(async () => Response.json({ model: await getDefaultModel() ?? null } satisfies DefaultModelResponse));
export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = z.object({ model: z.string().min(1).max(200) }).safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    await modelRegistryUseCases.selectDefault(parsed.data.model, user.email);
    return Response.json({ model: parsed.data.model } satisfies DefaultModelResponse);
  } catch (error) { return apiError(error); }
});
