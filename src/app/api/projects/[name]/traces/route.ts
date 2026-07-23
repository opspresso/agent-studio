import { withAuth } from "@/lib/session";
import { projectRepository, traceRepository } from "@/lib/container";
import { getProject } from "@/application/project/projectUseCases";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  try {
    await getProject(projectRepository, name);
    return Response.json({ traces: await traceRepository.listByProject(name, limit) });
  } catch (error) {
    return apiError(error);
  }
});
