import { usageUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { summaryQuerySchema } from "@/app/api/usages/summary/validation";

/**
 * The signed-in user's own daily spend over a range — the profile page's chart
 * and table, answered from the same rows the tier cap counts.
 *
 * Always the session user, so there is nothing to authorize beyond being
 * signed in. It reuses the summary endpoint's range validation so the three
 * cost surfaces cannot disagree about what a legal window is.
 */
export const GET = withAuth(async (user, request: Request) => {
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
    const items = await usageUseCases.memberUsage(user.email, parsed.data.from, parsed.data.to);
    return Response.json({ items });
  } catch (error) {
    return apiError(error);
  }
});
