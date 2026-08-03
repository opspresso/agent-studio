import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { agentSchema } from "@/app/api/projects/_lib/schemas";
import { withTenant } from "@/shared/tenantContext";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const authenticated = await authenticateExecution(request, name);
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { principal, tenant } = authenticated;
  return withTenant(tenant, async () => {
  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    const abortController = new AbortController();
    return await sseResponse(
      executeAgent(executionDeps, {
        project,
        version: versionEntity,
        messages: parsed.data.messages,
        actor: principalActor(principal),
        signal: abortController.signal,
      }),
      abortController,
    );
  } catch (error) {
    return apiError(error);
  }
  });
};
