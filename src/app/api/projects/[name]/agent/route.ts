import { requireAgentConfiguration } from "@/application/project/configurationUseCases";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectUseCases, signArtifactUrl } from "@/lib/container";
import { withAddressedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { executeAgent } from "@/application/execution/runProject";
import { agentSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { requestConversation } from "@/app/api/projects/_lib/conversation";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withTurnBody } from "@/app/api/_lib/body";
import {
  attachDocumentsToMessages,
  readExecutionDocuments,
} from "@/app/api/projects/_lib/documents";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  return withTurnBody(request, async (body) => {
    const parsed = agentSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    try {
      const project = await projectUseCases.get(name);
      const configuration = requireAgentConfiguration(project);
      const actor = principalActor(principal);
      const conversation = requestConversation(request, actor);
      const read = await readExecutionDocuments(executionDeps, { projectName: project.name, actor }, parsed.data.documents);
      const abortController = new AbortController();
      return await sseResponse(
        // API clients and Playground receive addressed files from the run bracket.
        withAddressedFiles(
          withLeadingWarnings(
            read.warnings,
            executeAgent(executionDeps, {
              project,
              configuration,
              messages: attachDocumentsToMessages(parsed.data.messages, read.documents),
              actor,
              ...(principal.caller ? { caller: principal.caller } : {}),
              ...(conversation ? { conversation } : {}),
              signal: abortController.signal,
            }),
          ),
          signArtifactUrl,
          VIEW_URL_TTL_SECONDS,
        ),
        abortController,
      );
    } catch (error) {
      return apiError(error, request);
    }
  });
};
