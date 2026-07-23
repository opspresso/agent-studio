import { withAuth } from "@/lib/session";
import { sseResponse } from "@/lib/sse";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import {
  executeAgent,
  executeProjectStream,
  executeVersion,
} from "@/application/execution/runProject";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { chatCompletionsSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { collectRun, toChatCompletion, toChatCompletionChunks } from "@/app/api/projects/_lib/openai";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const parsed = chatCompletionsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    const isAgent = project.projectType === "agent";
    const versionParams = {
      project,
      version: versionEntity,
      variables: parsed.data.variables,
      messages: parsed.data.messages,
      userEmail: user.email,
    };
    const agentParams = {
      project,
      version: versionEntity,
      messages: parsed.data.messages,
      userEmail: user.email,
    };

    if (parsed.data.stream) {
      const source = executeProjectStream(executionDeps, versionParams);
      return sseResponse(toChatCompletionChunks(source, versionEntity.model));
    }

    const result = isAgent
      ? await collectRun(executeAgent(executionDeps, agentParams), versionEntity.model)
      : await executeVersion(executionDeps, versionParams);
    return Response.json(toChatCompletion(result));
  } catch (error) {
    return apiError(error);
  }
});
