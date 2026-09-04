import { z } from "zod";
import { testModel } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";
import { editorBody } from "@/app/api/_lib/body";

const testSchema = z.object({ model: z.string().min(1).max(200) });

/**
 * POST /api/models/test — one probe through the model type's real channel.
 * A failed probe is the response body (`ok: false`), not a 5xx: the test
 * succeeded at testing, and its finding is the payload.
 */
export const POST = withAdminAuth(async (_user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await testModel(parsed.data.model));
  } catch (error) {
    return apiError(error);
  }
});
