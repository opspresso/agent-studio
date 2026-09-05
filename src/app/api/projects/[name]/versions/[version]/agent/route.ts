import { withLeadingWarnings } from "@/application/run/leadingWarnings";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectUseCases, signArtifactUrl, versionUseCases } from "@/lib/container";
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
  readBoundExecutionDocuments,
} from "@/app/api/projects/_lib/documents";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
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
      const versionEntity = await versionUseCases.get(name, version);
      const actor = principalActor(principal);
      const conversation = requestConversation(request, actor);
      const read = await readBoundExecutionDocuments(
        executionDeps,
        versionEntity,
        parsed.data.documents,
        request.signal,
        { actor, ...(conversation ? { conversation } : {}) },
      );
      const abortController = new AbortController();
      return await sseResponse(
        // A file chunk leaves here addressed: the object key and artifact id the
        // bracket put on it are this platform's own bookkeeping, and a caller
        // holding them can do nothing but wonder. The console's Playground and
        // compare view read this stream too, which is how both of them ended up
        // drawing the picture a run made and saying nothing about the document.
        withAddressedFiles(
          withLeadingWarnings(
            read.warnings,
            executeAgent(executionDeps, {
              project,
              version: versionEntity,
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
