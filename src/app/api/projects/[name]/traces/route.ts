import { withAuth } from "@/lib/session";
import { projectRepository, traceRepository } from "@/lib/container";
import { assertProjectOwner } from "@/application/project/projectUseCases";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const rawLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  try {
    // Traces hold other users' runtime inputs/outputs, so unlike the shared
    // project catalog they are owner-only.
    await assertProjectOwner(projectRepository, name, user.email);
    return Response.json({ traces: await traceRepository.listByProject(name, { limit, from, to }) });
  } catch (error) {
    return apiError(error);
  }
});
