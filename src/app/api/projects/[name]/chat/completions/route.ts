import { requireAgentConfiguration } from "@/application/project/configurationUseCases";
import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, projectUseCases, signArtifactUrl } from "@/lib/container";
import { resolveProducedFile, resolveProducedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { executeProject, executeProjectStream } from "@/application/execution/runProject";
import { chatCompletionsSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { requestConversation } from "@/app/api/projects/_lib/conversation";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withTurnBody } from "@/app/api/_lib/body";
import { toChatCompletion, toChatCompletionChunks } from "@/app/api/projects/_lib/openai";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  return withTurnBody(request, async (body) => {
    const parsed = chatCompletionsSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    try {
      const project = await projectUseCases.get(name);
      const configuration = requireAgentConfiguration(project);
      // The facade runs the Agent; this route wraps text, images and files
      // in the OpenAI-compatible response shape.
      const conversation = requestConversation(request, principalActor(principal));
      const params = {
        project,
        configuration,
        messages: parsed.data.messages,
        actor: principalActor(principal),
        ...(principal.caller ? { caller: principal.caller } : {}),
        ...(conversation ? { conversation } : {}),
      };

      // The two branches below answer with the same signer and the same lifetime,
      // so a file named in a stream and the same file named in a body are one
      // address.
      if (parsed.data.stream) {
        const abortController = new AbortController();
        const source = executeProjectStream(executionDeps, {
          ...params,
          signal: abortController.signal,
        });
        return await sseResponse(
          toChatCompletionChunks(source, configuration.model, (file) =>
            resolveProducedFile(file, signArtifactUrl, VIEW_URL_TTL_SECONDS),
          ),
          abortController,
        );
      }

      const result = await executeProject(executionDeps, { ...params, signal: request.signal });
      const produced = await resolveProducedFiles(
        result.files,
        signArtifactUrl,
        VIEW_URL_TTL_SECONDS,
      );
      return Response.json(
        toChatCompletion({
          ...result,
          files: produced.files,
          warnings: [...result.warnings, ...produced.warnings],
        }),
      );
    } catch (error) {
      return apiError(error, request);
    }
  });
};
