import { z } from "zod";
import { mcpUseCases } from "@/application/mcp";
import { withAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

const nameSchema = z.string().regex(/^[a-z0-9-]+$/);

export const POST = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!nameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }
  const result = await mcpUseCases.testConnection(name);
  if (result === null) {
    return Response.json({ error: "MCP server not found" }, { status: 404 });
  }
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 502 });
  }
  return Response.json({ tools: result.tools });
});
