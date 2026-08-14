import { runStrategyFor } from "@/application/execution/runProject";
import { sseResponse } from "@/app/api/_lib/sse";
import {
  artifactStorage,
  executionDeps,
  imageDeps,
  projectUseCases,
  versionUseCases,
} from "@/lib/container";
import { resolveProducedFiles } from "@/application/artifact/producedFiles";
import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import { generateImage } from "@/application/image/generateImage";
import { executeProject, executeProjectStream } from "@/application/execution/runProject";
import { predictSchema } from "@/app/api/projects/_lib/schemas";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { turnBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string; version: string }> };

export const POST = async (request: Request, ctx: RouteContext) => {
  const { name, version } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  const body = await turnBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = predictSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await projectUseCases.get(name);
    const versionEntity = await versionUseCases.get(name, version);
    if (runStrategyFor(project) === "image") {
      const image = await generateImage(imageDeps, {
        project,
        version: versionEntity,
        variables: parsed.data.variables,
        prompt: parsed.data.prompt,
        // With source images the prompt edits them instead of drawing anew.
        images: parsed.data.images,
        actor: principalActor(principal),
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
      actor: principalActor(principal),
      // Not on the image branch above: an image run's prompt is the rendered
      // template, with no system prompt for a caller block to live in.
      ...(principal.caller ? { caller: principal.caller } : {}),
    };
    // The strategy→executor mapping lives in runProject; this route only
    // decides how to serialise the answer.
    if (parsed.data.stream) {
      const abortController = new AbortController();
      return await sseResponse(
        executeProjectStream(executionDeps, { ...params, signal: abortController.signal }),
        abortController,
      );
    }
    const run = await executeProject(executionDeps, { ...params, signal: request.signal });
    // Files carry a reference, not bytes — the bracket kept those — so the
    // address is minted here, where the reader is known. A file that cannot be
    // addressed joins the warnings rather than being dropped in silence: prose
    // about a report with no report attached is what this endpoint used to send.
    const produced = await resolveProducedFiles(
      run.files,
      artifactStorage?.objects.sign,
      VIEW_URL_TTL_SECONDS,
    );
    const warnings = [...run.warnings, ...produced.warnings];
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
    return apiError(error);
  }
};
