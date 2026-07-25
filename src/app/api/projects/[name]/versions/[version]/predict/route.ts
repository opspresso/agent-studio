import { sseResponse } from "@/lib/sse";
import { executionDeps, imageDeps, projectRepository, versionRepository } from "@/lib/container";
import { generateImage } from "@/application/image/generateImage";
import { executeVersion, executeVersionStream } from "@/application/execution/runProject";
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
      messages: parsed.data.messages,
      userEmail: principal.email,
    };
    if (parsed.data.stream) {
      const abortController = new AbortController();
      return sseResponse(
        executeVersionStream(executionDeps, { ...params, signal: abortController.signal }),
        abortController,
      );
    }
    const result = await executeVersion(executionDeps, { ...params, signal: request.signal });
    return Response.json({ result: result.content, model: result.model, usage: result.usage });
  } catch (error) {
    return apiError(error);
  }
};
