import { z } from "zod";
import { mcpUseCases } from "@/application/mcp";
import { withAdminAuth, withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  url: z.url().optional(),
  description: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    return Response.json(await mcpUseCases.get(parseName(name)));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { name } = await ctx.params;
    return Response.json(await mcpUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    await mcpUseCases.remove(parseName(name));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
