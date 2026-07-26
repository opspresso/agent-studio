import { z } from "zod";
import { agentUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const messageSchema = z.object({ message: z.string().min(1) });

export const POST = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { name } = await ctx.params;
    const result = await agentUseCases.sendMessage(parseName(name), parsed.data.message);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ text: result.text });
  } catch (error) {
    return apiError(error);
  }
});
