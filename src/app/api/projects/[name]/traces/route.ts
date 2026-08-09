import { withAuth } from "@/lib/session";
import { projectUseCases, traceRepository } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  if (
    (from && !DATE_RE.test(from)) ||
    (to && !DATE_RE.test(to)) ||
    (from && to && from > to)
  ) {
    return Response.json({ error: "from/to must be YYYY-MM-DD with from ≤ to" }, { status: 400 });
  }
  try {
    // Traces hold other users' runtime inputs/outputs, so unlike the shared
    // project catalog they are readable only by the owner and by admins.
    await projectUseCases.assertWritable(name, user.email);
    return Response.json({ traces: await traceRepository.listByProject(name, { limit, from, to }) });
  } catch (error) {
    return apiError(error);
  }
});
