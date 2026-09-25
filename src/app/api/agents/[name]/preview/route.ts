import { withMemberAuth } from "@/lib/session";
import { executionDeps, agentUseCases, configurationUseCases } from "@/lib/container";
import { previewPrompt } from "@/application/execution/runAgent";
import { previewPromptSchema } from "@/app/api/agents/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sessionCaller } from "@/app/api/_lib/caller";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Assemble what the draft in the editor would send, without running it.
 *
 * Tier-gated at `member`, not owner-gated like saving one. A draft's MCP bindings
 * attach chosen headers to a registered server, but that is not an authority the gate can reserve:
 * any member binds the same registry server with the same headers from a
 * agent of their own. A masked header resolves only against this agent's
 * stored binding for the same server name, so the most a non-owner's preview
 * sends anywhere is what any run they may already start sends. The URL always
 * comes from the registry, so the SSRF surface is a run's.
 *
 * The rung is `member` rather than a bare session because of *what the preview
 * is*: the assembled text is the system prompt, the skill table and the tool
 * names — the same capability registry a guest is refused at `withMemberAuth`,
 * only rendered per agent instead of as a catalogue. Leaving this session-
 * gated would hand back through one agent page exactly what the four
 * Intelligence pages withhold. Running the agent stays open to a guest; a run
 * answers, it does not enumerate.
 *
 * When the draft enables memory recall and supplies a preview request, this
 * route also makes the same read-only recall call as a run. That does not widen
 * access: the member could already run the accessible agent, and the MCP
 * receives the same signed-in email identity.
 */
export const POST = withMemberAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = previewPromptSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  const caller = sessionCaller(user);
  try {
    const agent = await agentUseCases.assertAccessible(name, user.email);
    const { message, ...draft } = parsed.data;
    const preview = await previewPrompt(executionDeps, {
      signal: request.signal,
      agent,
      configuration: {
        ...draft,
        // The console echoes overrides masked; the draft's masks resolve
        // against the stored Agent, exactly as the save path does.
        mcpList: await configurationUseCases.resolveDraftBindings(name, draft.mcpList, user.email),
        agentName: name,
        // The draft's Agent identity is bound to the requested Agent.
      },
      // What memory recall and capability discovery search with.
      ...(message ? { message } : {}),
      actor: { kind: "user", id: user.email },
      // Preview uses the same caller identity as a run started from this page.
      ...(caller ? { caller } : {}),
    });
    return Response.json(preview);
  } catch (error) {
    return apiError(error);
  }
});
