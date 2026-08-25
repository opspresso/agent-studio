import { z } from "zod";
import { agentUseCases } from "@/lib/container";
import { withAdminAuth, withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  url: z.url().optional(),
  protocol: z.enum(["openai", "a2a"]).optional(),
  description: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withMemberAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    return Response.json(await agentUseCases.get(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { name } = await ctx.params;
    return Response.json(await agentUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    await agentUseCases.remove(parseName(name), user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
