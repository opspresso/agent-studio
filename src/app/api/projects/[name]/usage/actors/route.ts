import { withAuth } from "@/lib/session";
import { usageUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { summaryQuerySchema } from "@/app/api/usages/summary/validation";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Who spent this project's budget, per UTC day.
 *
 * Owner/admin only, on the same reasoning as traces: the project *totals* are
 * open to any signed-in user because the catalog is shared, but a breakdown by
 * caller names individuals and what they ran. It reuses the summary endpoint's
 * range validation so the two cannot disagree about what a legal window is.
 */
export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const parsed = summaryQuerySchema.safeParse({
    from: params.get("from"),
    to: params.get("to"),
  });
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    );
  }
  try {
    return Response.json(
      await usageUseCases.actors(name, user.email, parsed.data.from, parsed.data.to),
    );
  } catch (error) {
    return apiError(error);
  }
});
