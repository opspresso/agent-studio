import { sseResponse } from "@/app/api/_lib/sse";
import { executionDeps, imageDeps, projectRepository, versionRepository } from "@/lib/container";
import { generateImage } from "@/application/image/generateImage";
import {
  executeAgent,
  executeProjectStream,
  executeVersion,
} from "@/application/execution/runProject";
import { collectRun } from "@/app/api/projects/_lib/openai";
import { getProject } from "@/application/project/projectUseCases";
import { getVersion } from "@/application/project/versionUseCases";
import { predictSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution } from "@/app/api/projects/_lib/executionAuth";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  const parsed = predictSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await getProject(projectRepository, name);
    const versionEntity = await getVersion(versionRepository, name, version);
    if (project.projectType === "image") {
      const image = await generateImage(imageDeps, {
        project,
        version: versionEntity,
        variables: parsed.data.variables,
        prompt: parsed.data.prompt,
        // With source images the prompt edits them instead of drawing anew.
        images: parsed.data.images,
        size: parsed.data.size,
        quality: parsed.data.quality,
        signal: request.signal,
      });
      return Response.json(image);
    }
    const params = {
      project,
      version: versionEntity,
      variables: parsed.data.variables,
      messages: parsed.data.messages ?? [],
      userEmail: principal.email,
    };
    // Dispatch on projectType like /chat/completions does: an agent project run
    // through the single-shot path would silently lose every skill, MCP server
    // and subagent its version declares.
    if (parsed.data.stream) {
      const abortController = new AbortController();
      return sseResponse(
        executeProjectStream(executionDeps, { ...params, signal: abortController.signal }),
        abortController,
      );
    }
    if (project.projectType === "agent") {
      const run = await collectRun(
        executeAgent(executionDeps, {
          project,
          version: versionEntity,
          messages: params.messages,
          userEmail: principal.email,
          signal: request.signal,
        }),
        versionEntity.model,
      );
      return Response.json({
        result: run.content,
        model: run.model,
        usage: run.usage,
        ...(run.images.length > 0 ? { images: run.images } : {}),
      });
    }
    const result = await executeVersion(executionDeps, { ...params, signal: request.signal });
    return Response.json({ result: result.content, model: result.model, usage: result.usage });
  } catch (error) {
    return apiError(error);
  }
};
