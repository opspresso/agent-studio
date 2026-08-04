import { memberUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";

export const GET = withAdminAuth(async () => {
  try {
    return Response.json({ members: await memberUseCases.list() });
  } catch (error) {
    return apiError(error);
  }
});
