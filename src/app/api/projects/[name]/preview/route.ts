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
 * Session-gated like running a project, not owner-gated like saving one. This
 * used to be the owner's, on the argument that the draft's MCP bindings attach
 * chosen headers to a registered server — but that is not an authority the gate
 * can reserve: any signed-in user binds the same registry server with the same
 * headers from a project of their own. A masked header resolves only against
 * this project's stored binding for the same server name, so the most a
 * non-owner's preview sends anywhere is what any run they may already start
 * sends; and the assembled text — system prompt, skill table, tool names — is
 * composed of what `GET /versions` already answers with a session. The URL
 * always comes from the registry, so the SSRF surface is a run's.
 */
export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = previewPromptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  const caller = sessionCaller(user);
  try {
    const project = await projectUseCases.get(name);
    const { variables, versionName, message, ...draft } = parsed.data;
    const preview = await previewPrompt(executionDeps, {
      signal: request.signal,
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
