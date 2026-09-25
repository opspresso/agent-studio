import { requireAgentConfiguration } from "@/application/agent/configurationUseCases";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, agentUseCases, signArtifactUrl } from "@/lib/container";
import { withAddressedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { executeAgent } from "@/application/execution/runAgent";
import { agentSchema } from "@/app/api/agents/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/agents/_lib/executionAuth";
import { requestConversation } from "@/app/api/agents/_lib/conversation";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withTurnBody } from "@/app/api/_lib/body";
import {
  attachDocumentsToMessages,
  readExecutionDocuments,
} from "@/app/api/agents/_lib/documents";

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
      const agent = await agentUseCases.get(name);
      const configuration = requireAgentConfiguration(agent);
      const actor = principalActor(principal);
      const conversation = requestConversation(request, actor);
      const read = await readExecutionDocuments(executionDeps, { agentName: agent.name, actor }, parsed.data.documents);
      const abortController = new AbortController();
      return await sseResponse(
        // API clients and Playground receive addressed files from the run bracket.
        withAddressedFiles(
          withLeadingWarnings(
            read.warnings,
            executeAgent(executionDeps, {
              agent,
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
