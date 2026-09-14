import { withMemberAuth } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import type { WorkspaceEvent } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

export interface WorkspaceEventsResponse { events: WorkspaceEvent[]; nextSeq: number; hasMore: boolean }
export const GET = withMemberAuth(async (user, request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const query = new URL(request.url).searchParams;
    const afterSeq = Number(query.get("after") ?? 0);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return Response.json({ error: "Invalid event cursor" }, { status: 400 });
    const events = await workspaceUseCases.events((await context.params).id, user.email, query.get("run") ?? "", afterSeq);
    return Response.json({ events, nextSeq: events.at(-1)?.seq ?? afterSeq, hasMore: events.length === WORKSPACE_LIMITS.maxPage } satisfies WorkspaceEventsResponse);
  } catch (error) { return apiError(error); }
});
