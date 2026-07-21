import { withAuth } from "@/lib/session";
import { sseResponse } from "@/lib/sse";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { agentSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    return sseResponse(
      executeAgent(executionDeps, {
        project,
        version: versionEntity,
        messages: parsed.data.messages,
        userEmail: user.email,
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});
