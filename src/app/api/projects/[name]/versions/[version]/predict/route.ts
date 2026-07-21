import { withAuth } from "@/lib/session";
import { sseResponse } from "@/lib/sse";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { executeVersion, executeVersionStream } from "@/application/execution/runProject";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { predictSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const parsed = predictSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    const params = {
      project,
      version: versionEntity,
      variables: parsed.data.variables,
      messages: parsed.data.messages,
      userEmail: user.email,
    };
    if (parsed.data.stream) {
      return sseResponse(executeVersionStream(executionDeps, params));
    }
    const result = await executeVersion(executionDeps, params);
    return Response.json({ result: result.content, model: result.model, usage: result.usage });
  } catch (error) {
    return apiError(error);
  }
});
