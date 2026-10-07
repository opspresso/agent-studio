import { requireAgentConfiguration } from "@/application/agent/configurationUseCases";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, agentUseCases, signArtifactUrl, evaluationUseCases } from "@/lib/container";
import { ConflictError } from "@/application/errors";
import { withAddressedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { executeAgent } from "@/application/execution/runAgent";
import { agentSchema } from "@/app/api/agents/_lib/schemas";
import { authenticateExecution, principalRunContext } from "@/app/api/agents/_lib/executionAuth";
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
      if (parsed.data.expectedUpdatedAt && parsed.data.expectedUpdatedAt !== agent.updatedAt) {
        throw new ConflictError("Agent configuration changed; reload the page before running");
      }
      const configuration = requireAgentConfiguration(agent);
      const context = principalRunContext(principal, agent.name);
      const { actor } = context;
      const conversation = requestConversation(request, principal.userId);
      const read = await readExecutionDocuments(executionDeps, { agentName: agent.name, actor }, parsed.data.documents);
      const abortController = new AbortController();
      const input = { agent, configuration,
        messages: attachDocumentsToMessages(parsed.data.messages, read.documents), ...context,
        ...(conversation ? { conversation } : {}), signal: abortController.signal };
      return await sseResponse(
        // API clients and Playground receive addressed files from the run bracket.
        withAddressedFiles(
          withLeadingWarnings(
            read.warnings,
            parsed.data.captureEvaluation ? evaluationUseCases.run(input, read.warnings) : executeAgent(executionDeps, input),
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
