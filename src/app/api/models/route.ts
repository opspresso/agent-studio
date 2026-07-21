import { getVisibleModels } from "@/domain/llm/models";
import { withAuth } from "@/lib/session";

/** GET /api/models — visible (non-hidden) model configs for the console. */
export const GET = withAuth(async () => {
  return Response.json({ models: getVisibleModels() });
});
