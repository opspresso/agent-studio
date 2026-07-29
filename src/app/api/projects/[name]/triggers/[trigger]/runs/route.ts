import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; trigger: string }> };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  const raw = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  try {
    return Response.json({ runs: await triggerUseCases.runs(name, trigger, limit, user.email) });
  } catch (error) {
    return apiError(error);
  }
});
