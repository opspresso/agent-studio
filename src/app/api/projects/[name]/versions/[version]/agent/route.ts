import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectUseCases, versionUseCases } from "@/lib/container";
import { executeAgent } from "@/application/execution/runProject";
import { agentSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await projectUseCases.get(name);
    const versionEntity = await versionUseCases.get(name, version);
    const abortController = new AbortController();
    return await sseResponse(
      executeAgent(executionDeps, {
        project,
        version: versionEntity,
        messages: parsed.data.messages,
        actor: principalActor(principal),
        ...(principal.caller ? { caller: principal.caller } : {}),
        signal: abortController.signal,
      }),
      abortController,
    );
  } catch (error) {
    return apiError(error);
  }
};
