import type { McpTool } from "@/domain/mcp/types";
import { mcpUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, parseName } from "@/app/api/_lib/http";

export interface McpToolsResponse { tools: McpTool[] }

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
  try {
    const { name } = await ctx.params;
    const result = await mcpUseCases.testConnection(parseName(name), { userId: user.id, email: user.email });
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ tools: result.tools } satisfies McpToolsResponse);
  } catch (error) {
    return apiError(error);
  }
});
