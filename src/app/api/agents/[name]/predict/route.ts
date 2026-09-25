import { requireAgentConfiguration } from "@/application/agent/configurationUseCases";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { sseResponse } from "@/app/api/_lib/sse";
import {
  executionDeps,
  agentUseCases,
  signArtifactUrl,
} from "@/lib/container";
import { resolveProducedFiles, withAddressedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { collectAgentRun, streamAgentExecution } from "@/application/execution/runAgent";
import { predictSchema } from "@/app/api/agents/_lib/schemas";
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
    const parsed = predictSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    try {
      const agent = await agentUseCases.get(name);
      const configuration = requireAgentConfiguration(agent);
      const actor = principalActor(principal);
      const conversation = requestConversation(request, actor);
      const read = await readExecutionDocuments(executionDeps, { agentName: agent.name, actor }, parsed.data.documents);
      const params = {
        agent,
        configuration,
        messages: attachDocumentsToMessages(parsed.data.messages ?? [], read.documents),
        actor,
        ...(principal.caller ? { caller: principal.caller } : {}),
        ...(conversation ? { conversation } : {}),
      };
      // The facade owns execution; this route chooses the response representation.
      if (parsed.data.stream) {
        const abortController = new AbortController();
        return await sseResponse(
          // Addressed on the way out, exactly like `/agent`: this branch answers
          // in raw chunks too, and a file frame carrying an object key is the
          // same non-answer there as it was here.
          withAddressedFiles(
            withLeadingWarnings(
              read.warnings,
              streamAgentExecution(executionDeps, { ...params, signal: abortController.signal }),
            ),
            signArtifactUrl,
            VIEW_URL_TTL_SECONDS,
          ),
          abortController,
        );
      }
      const run = await collectAgentRun(executionDeps, { ...params, signal: request.signal });
      // Files carry a reference, not bytes — the bracket kept those — so the
      // address is minted here, where the reader is known. A file that cannot be
      // addressed joins the warnings rather than being dropped in silence: prose
      // about a report without the report is not a complete answer.
      const produced = await resolveProducedFiles(
        run.files,
        signArtifactUrl,
        VIEW_URL_TTL_SECONDS,
      );
      const warnings = [...read.warnings, ...run.warnings, ...produced.warnings];
      return Response.json({
        result: run.content,
        model: run.model,
        usage: run.usage,
        // Why the run ended. Without it a partial answer — the turn guard, a
        // provider output cut — was indistinguishable from a finished one on the
        // one surface that returns a bare `result`.
        ...(run.termination ? { finishReason: run.termination } : {}),
        // What the run lost on the way to that answer, for the same reason: a
        // stream says it in a `warning` frame, and a collected body had nowhere.
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(run.images.length > 0 ? { images: run.images } : {}),
        // What it produced beside the answer. Images ride inline because a caller
        // renders them; a document is taken away, so it travels as an address.
        ...(produced.files.length > 0 ? { files: produced.files } : {}),
      });
    } catch (error) {
      return apiError(error, request);
    }
  });
};
