import { withAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import { getChat } from "@/application/chat/getChat";
import { deleteChat } from "@/application/chat/deleteChat";
import { chatDeps } from "../_deps";

type RouteContext = { params: Promise<{ chatId: string }> };

export const GET = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  // `sinceSeq` asks for the tail: the thread already holds everything up to it
  // and merges what comes back. Anything that is not a non-negative number is
  // read as "no bound" rather than refused — the whole transcript is always a
  // correct answer to this request, just a more expensive one.
  // Read as a string first: `Number(null)` is 0, and 0 is a *valid* sequence
  // here — the first message of a chat has it — so an absent parameter parsed
  // that way would silently drop the opening turn.
  const raw = new URL(request.url).searchParams.get("sinceSeq");
  const asked = raw === null ? Number.NaN : Number(raw);
  const sinceSeq = Number.isFinite(asked) && asked >= 0 ? Math.floor(asked) : undefined;
  try {
    const result = await getChat(
      chatDeps,
      chatId,
      user.email,
      sinceSeq === undefined ? {} : { sinceSeq },
    );
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { chatId } = await ctx.params;
  try {
    await deleteChat(chatDeps, chatId, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
