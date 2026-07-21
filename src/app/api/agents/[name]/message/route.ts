import { z } from "zod";
import { agentUseCases } from "@/application/agent";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

const nameSchema = z.string().regex(/^[a-z0-9-]+$/);
const messageSchema = z.object({ message: z.string().min(1) });

export const POST = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const result = await agentUseCases.sendMessage(name, parsed.data.message);
  if (result === null) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 502 });
  }
  return Response.json({ text: result.text });
});
