import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { parsePageLimit } from "@/shared/pageLimit";
import type { TriggerRunView } from "@/application/trigger/triggerUseCases";

export interface TriggerRunsResponse { runs: TriggerRunView[] }

type RouteContext = { params: Promise<{ name: string; trigger: string }> };

const DEFAULT_LIMIT = 20;

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  const { limit } = parsePageLimit(new URL(request.url).searchParams.get("limit"), {
    fallback: DEFAULT_LIMIT,
  });
  try {
    return Response.json({ runs: await triggerUseCases.runs(name, trigger, limit, user.email) } satisfies TriggerRunsResponse);
  } catch (error) {
    return apiError(error);
  }
});
