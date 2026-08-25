import { z } from "zod";
import { agentUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const messageSchema = z.object({ message: z.string().min(1) });

export const POST = withMemberAuth(async (_user, request: Request, ctx: RouteContext) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = messageSchema.safeParse(body);
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
