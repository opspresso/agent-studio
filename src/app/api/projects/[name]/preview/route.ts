import { withAuth } from "@/lib/session";
import { executionDeps, projectUseCases, versionUseCases } from "@/lib/container";
import { previewPrompt } from "@/application/execution/runProject";
import { previewPromptSchema } from "@/app/api/projects/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sessionCaller } from "@/app/api/_lib/caller";

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
  const caller = sessionCaller(user);
  try {
    const project = await projectUseCases.assertWritable(name, user.email);
    const { variables, versionName, message, ...draft } = parsed.data;
    const preview = await previewPrompt(executionDeps, {
      project,
      version: {
        ...draft,
        // The console echoes overrides masked; the draft's masks resolve
        // against the stored version, exactly as the save path does.
        mcpList: await versionUseCases.resolveDraftMcpBindings(name, versionName, draft.mcpList),
        projectName: name,
        // The draft may not be saved yet, so it has no name or timestamp of its
        // own; neither reaches the assembled prompt.
        versionName: "draft",
        createdAt: new Date().toISOString(),
      },
      variables,
      // What capability discovery searches with, when the version enables it.
      ...(message ? { message } : {}),
      // The person looking at the preview is the one a run started from this
      // page would name. Without it the Playground showed a prompt one block
      // short of what the version actually sends.
      ...(caller ? { caller } : {}),
    });
    return Response.json(preview);
  } catch (error) {
    return apiError(error);
  }
});
