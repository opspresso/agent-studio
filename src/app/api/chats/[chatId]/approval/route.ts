import { z } from "zod";
import { withAuth } from "@/lib/session";
import { withTurnBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { getChatApproval, discardChatApproval, resumeChatApproval } from "@/application/chat/approval";
import { watchChatCancel } from "@/application/chat/cancelRun";
import { chatDeps } from "../../_deps";
import { detachedRunResponse } from "../../_lib/detachedRun";

type RouteContext = { params: Promise<{ chatId: string }> };
const revisionSchema = z.object({ revision: z.number().int().positive() });
const decisionsSchema = revisionSchema.extend({ decisions: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), approve: z.boolean() })).min(1).max(128) });
export interface ChatApprovalResponse { pending: Awaited<ReturnType<typeof getChatApproval>> }

export const GET = withAuth(async (user, _request: Request, context: RouteContext) => {
  try { return Response.json({ pending: await getChatApproval(chatDeps, (await context.params).chatId, user.email) } satisfies ChatApprovalResponse); }
  catch (error) { return apiError(error); }
});

export const POST = withAuth(async (user, request: Request, context: RouteContext) => withTurnBody(request, async (body, admission) => {
  const parsed = decisionsSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const { chatId } = await context.params;
  try {
    const controller = new AbortController();
    const run = await resumeChatApproval(chatDeps, { chatId, userEmail: user.email, ...parsed.data, signal: controller.signal });
    const stopWatch = watchChatCancel(chatDeps.chats, chatId, run.runId, controller);
    const detached = await detachedRunResponse({ head: { runId: run.runId, elapsedMs: Date.now() - run.startedAtMs }, stream: run.stream, onClientGone: run.onClientGone, onDrained: stopWatch });
    admission.retainUntil(detached.drained);
    return detached.response;
  } catch (error) { return apiError(error); }
}));

export const DELETE = withAuth(async (user, request: Request, context: RouteContext) => withTurnBody(request, async (body) => {
  const parsed = revisionSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    await discardChatApproval(chatDeps, (await context.params).chatId, user.email, parsed.data.revision);
    return new Response(null, { status: 204 });
  } catch (error) { return apiError(error); }
}));
