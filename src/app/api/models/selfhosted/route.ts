import { listSelfHostedServedModels } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

/**
 * GET /api/models/selfhosted — what the self-hosted channel is serving right
 * now, as the declaration aid on the /models console. The serving stack is
 * the only party that knows this; declaring is still the admin's act, through
 * `PUT /api/settings`. A 400 names the missing channel; a channel that does
 * not answer is reported as the error it is.
 */
export const GET = withAdminAuth(async () => {
  try {
    return Response.json({ models: await listSelfHostedServedModels() });
  } catch (error) {
    return apiError(error);
  }
});
