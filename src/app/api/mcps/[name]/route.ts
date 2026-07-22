import { z } from "zod";
import { mcpUseCases } from "@/application/mcp";
import { withAuth } from "@/lib/session";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";

type RouteContext = { params: Promise<{ name: string }> };

const nameSchema = z.string().regex(/^[a-z0-9-]+$/);
const updateSchema = z.object({
  url: z.url().optional(),
  description: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const GET = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const server = await mcpUseCases.get(name);
  if (!server) {
    return Response.json({ error: "MCP server not found" }, { status: 404 });
  }
  return Response.json(server);
});

export const PUT = withAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  let server;
  try {
    server = await mcpUseCases.update(name, parsed.data);
  } catch (error) {
    if (error instanceof SsrfError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (!server) {
    return Response.json({ error: "MCP server not found" }, { status: 404 });
  }
  return Response.json(server);
});

export const DELETE = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const removed = await mcpUseCases.remove(name);
  if (!removed) {
    return Response.json({ error: "MCP server not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
});
