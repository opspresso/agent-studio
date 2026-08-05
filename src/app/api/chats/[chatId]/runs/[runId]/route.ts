import { withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { cancelChatRun } from "@/application/chat/cancelRun";
import { chatDeps } from "../../../_deps";
import { runIdSchema } from "../../../_lib/schemas";

type RouteContext = { params: Promise<{ chatId: string; runId: string }> };

/**
 * Stop a run in progress.
 *
 * A chat run outlives the connection that started it, so this is the only way
 * to end one early — and it is a request rather than a command: the instance
 * answering here is not necessarily the one running the answer, so it persists
 * the ask and the run picks it up on its next poll.
 */
export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId, runId } = await ctx.params;
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // `cancelled: false` means the run had already finished — the press raced
    // the answer, which is a 200 with nothing to do, not a failure.
    const result = await cancelChatRun(chatDeps, {
      chatId,
      runId: parsed.data,
      userEmail: user.email,
    });
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
});
