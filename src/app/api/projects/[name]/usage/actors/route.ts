import { withAuth } from "@/lib/session";
import {
  projectRepository,
  secretCipher,
  slackUserProfile,
  usageRepository,
} from "@/lib/container";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { listProjectActors } from "@/application/usage/listActors";
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
    const project = await assertProjectWritable(projectRepository, name, user.email);
    const items = await listProjectActors(
      { usage: usageRepository, cipher: secretCipher, resolveSlackProfile: slackUserProfile },
      project,
      parsed.data.from,
      parsed.data.to,
    );
    return Response.json({ items });
  } catch (error) {
    return apiError(error);
  }
});
