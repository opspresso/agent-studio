import { withAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sseResponse } from "@/app/api/_lib/sse";
import { openRunLogReplay } from "@/application/chat/replayRunLog";
import { chatDeps } from "../../../../_deps";
import { runIdSchema } from "../../../../_lib/schemas";
import { withReplayFrames } from "../../../../_lib/frames";

type RouteContext = { params: Promise<{ chatId: string; runId: string }> };

/**
 * Watch a run already in progress: everything it has produced so far, then the
 * rest as it arrives.
 *
 * No `detachOnReturn` here, unlike the routes that *start* a run. This stream
 * only reads — a reader that leaves costs nothing to stop, and there is nothing
 * behind it to keep alive.
 */
export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId, runId } = await ctx.params;
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const stream = await openRunLogReplay(chatDeps, {
      chatId,
      runId: parsed.data,
      userEmail: user.email,
    });
    // The same frames a run's own stream carries, so one client reducer reads
    // both — including the trailing one, which is what says the run is over
    // rather than the connection.
    return await sseResponse(withReplayFrames({ runId: parsed.data }, stream));
  } catch (error) {
    return apiError(error);
  }
});
