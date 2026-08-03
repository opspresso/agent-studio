import { z } from "zod";
import { agentUseCases } from "@/lib/container";
import { withAdminAuth, withAuth } from "@/lib/session";
import { recordAudit } from "@/application/audit/auditLog";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

const updateSchema = z.object({
  url: z.url().optional(),
  protocol: z.enum(["openai", "a2a"]).optional(),
  description: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    return Response.json(await agentUseCases.get(parseName(name)));
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
    return Response.json(await agentUseCases.update(parseName(name), parsed.data));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAdminAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    await agentUseCases.remove(parseName(name));
    // A shared registry entry is not the deleter's to lose quietly: every
    // project that bound it is affected, and the row naming who registered it
    // goes with it.
    await recordAudit({
      action: "registry.delete",
      actorEmail: user.email,
      target: `agent:${name}`,
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
