import { withAuth } from "@/lib/session";
import { projectRepository, traceRepository } from "@/lib/container";
import { getProject } from "@/application/project/projectUseCases";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; traceId: string }> };

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name, traceId } = await ctx.params;
  try {
    await getProject(projectRepository, name);
    const trace = await traceRepository.get(traceId);
    if (!trace || trace.projectName !== name) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
    return Response.json(trace);
  } catch (error) {
    return apiError(error);
  }
});
