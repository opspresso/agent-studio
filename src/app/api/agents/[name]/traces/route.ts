import { withAuth } from "@/lib/session";
import { traceUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { isUtcDay } from "@/shared/date";
import { parsePageLimit } from "@/shared/pageLimit";

type RouteContext = { params: Promise<{ name: string }> };

/** A trace list is a page of a run history, not an export; the ceiling is the shared one. */
const DEFAULT_LIMIT = 50;

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const { limit } = parsePageLimit(params.get("limit"), { fallback: DEFAULT_LIMIT });
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  // `isUtcDay`, not a shape regex: `2026-02-31` must not ride into the GSI range
  // condition as written.
  if (
    (from && !isUtcDay(from)) ||
    (to && !isUtcDay(to)) ||
    (from && to && from > to)
  ) {
    return Response.json({ error: "from/to must be YYYY-MM-DD with from ≤ to" }, { status: 400 });
  }
  try {
    return Response.json({ traces: await traceUseCases.list(name, user.email, { limit, from, to }) });
  } catch (error) {
    return apiError(error);
  }
});
