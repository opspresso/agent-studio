import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { parsePageLimit } from "@/shared/pageLimit";

type RouteContext = { params: Promise<{ name: string; trigger: string }> };

const DEFAULT_LIMIT = 20;

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  const { limit } = parsePageLimit(new URL(request.url).searchParams.get("limit"), {
    fallback: DEFAULT_LIMIT,
  });
  try {
    return Response.json({ runs: await triggerUseCases.runs(name, trigger, limit, user.email) });
  } catch (error) {
    return apiError(error);
  }
});
