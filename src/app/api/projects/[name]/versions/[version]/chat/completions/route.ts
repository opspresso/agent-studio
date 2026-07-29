import { runStrategyFor } from "@/application/execution/runProject";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import {
  executeAgent,
  executeProjectStream,
  executeVersion,
} from "@/application/execution/runProject";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { chatCompletionsSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { collectRun, toChatCompletion, toChatCompletionChunks } from "@/app/api/projects/_lib/openai";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  const parsed = chatCompletionsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    const isAgent = runStrategyFor(project) === "agent";
    const versionParams = {
      project,
      version: versionEntity,
      variables: parsed.data.variables,
      messages: parsed.data.messages,
      actor: principalActor(principal),
    };
    const agentParams = {
      project,
      version: versionEntity,
      messages: parsed.data.messages,
      actor: principalActor(principal),
    };

    if (parsed.data.stream) {
      const abortController = new AbortController();
      const source = executeProjectStream(executionDeps, {
        ...versionParams,
        signal: abortController.signal,
      });
      return sseResponse(
        toChatCompletionChunks(source, versionEntity.model),
        abortController,
      );
    }

    const result = isAgent
      ? await collectRun(
          executeAgent(executionDeps, { ...agentParams, signal: request.signal }),
          versionEntity.model,
        )
      : await executeVersion(executionDeps, { ...versionParams, signal: request.signal });
    return Response.json(toChatCompletion(result));
  } catch (error) {
    return apiError(error);
  }
};
