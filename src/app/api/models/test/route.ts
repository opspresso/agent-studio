import { z } from "zod";
import { testModel } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

const testSchema = z.object({ model: z.string().min(1).max(200) });

/**
 * POST /api/models/test — one probe completion through the real channel.
 * A failed probe is the response body (`ok: false`), not a 5xx: the test
 * succeeded at testing, and its finding is the payload.
 */
export const POST = withAdminAuth(async (_user, request: Request) => {
  const parsed = testSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await testModel(parsed.data.model));
  } catch (error) {
    return apiError(error);
  }
});
