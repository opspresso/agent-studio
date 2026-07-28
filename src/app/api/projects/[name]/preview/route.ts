import { withAuth } from "@/lib/session";
import { executionDeps, projectRepository } from "@/lib/container";
import { assertProjectWritable } from "@/application/project/projectUseCases";
import { previewPrompt } from "@/application/execution/runProject";
import { previewPromptSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Assemble what the draft in the editor would send, without running it.
 *
 * Owner or admin, unlike reading or running a project: the body is an unsaved
 * version, and its MCP bindings may override the outbound headers a request
 * carries to a registered server — the same authority saving a version has.
 * The URL always comes from the registry, so the SSRF surface is a run's.
 */
export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = previewPromptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const project = await assertProjectWritable(projectRepository, name, user.email);
    const { variables, ...draft } = parsed.data;
    const preview = await previewPrompt(executionDeps, {
      project,
      version: {
        ...draft,
        projectName: name,
        // The draft may not be saved yet, so it has no name or timestamp of its
        // own; neither reaches the assembled prompt.
        versionName: "draft",
        createdAt: new Date().toISOString(),
      },
      variables,
    });
    return Response.json(preview);
  } catch (error) {
    return apiError(error);
  }
});
