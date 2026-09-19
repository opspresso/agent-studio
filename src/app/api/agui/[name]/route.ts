import { aguiDeps } from "@/lib/container";
import { runErrorEvent } from "@/application/agui/events";
import { resolveAguiProject, streamAguiRun } from "@/application/agui/run";
import { runAgentInputSchema } from "@/app/api/agui/_lib/schema";
import { authenticateExecution, principalActor } from "@/app/api/projects/_lib/executionAuth";
import { aguiConversation } from "@/app/api/projects/_lib/conversation";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { withTurnBody } from "@/app/api/_lib/body";
import { sseResponseRaw } from "@/app/api/_lib/sse";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * AG-UI endpoint: a `RunAgentInput` in, an event stream out.
 *
 * Authenticated like the three execution endpoints — a project API token, or
 * the console session — because the caller is an application this project's
 * owner is embedding it in, which is what a project token is for. Published
 * only: the application is an external surface, and a draft must not reach
 * its users. The thread the client names is the run's conversation, so an MCP
 * server that keeps state and a remote agent a transfer reaches both see one
 * conversation across the thread's runs.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { name } = await ctx.params;
  const principal = await authenticateExecution(request, name);
  if (principal instanceof Response) {
    return principal;
  }
  return withTurnBody(request, async (body) => {
    const parsed = runAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(parsed.error);
    }
    try {
      const exposed = await resolveAguiProject(aguiDeps, name);
      if (!exposed) {
        return Response.json(
          { error: "Project not found or has no Agent configuration" },
          { status: 404 },
        );
      }
      const actor = principalActor(principal);
      const abortController = new AbortController();
      return await sseResponseRaw(
        streamAguiRun(aguiDeps, {
          project: exposed.project,
          configuration: exposed.configuration,
          input: parsed.data,
          actor,
          ...(principal.caller ? { caller: principal.caller } : {}),
          conversation: aguiConversation(actor, parsed.data.threadId),
          signal: abortController.signal,
        }),
        abortController,
        // A failure the translator never saw — the run's first pull failing
        // after the response was already built — still answers in the
        // protocol's frame, which a client accepts as the first event.
        { errorFrame: runErrorEvent },
      );
    } catch (error) {
      return apiError(error, request);
    }
  });
}
