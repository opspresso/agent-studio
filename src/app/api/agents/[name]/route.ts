import { z } from "zod";
import { agentUseCases } from "@/application/agent";
import { withAdminAuth, withAuth } from "@/lib/session";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";

type RouteContext = { params: Promise<{ name: string }> };

const nameSchema = z.string().regex(/^[a-z0-9-]+$/);
const updateSchema = z.object({
  url: z.url().optional(),
  protocol: z.enum(["openai", "a2a"]).optional(),
  description: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const agent = await agentUseCases.get(name);
  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  return Response.json(agent);
});

export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  let agent;
  try {
    agent = await agentUseCases.update(name, parsed.data);
  } catch (error) {
    if (error instanceof SsrfError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  return Response.json(agent);
});

export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const removed = await agentUseCases.remove(name);
  if (!removed) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
});
