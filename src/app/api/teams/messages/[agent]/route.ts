import { agentTeamsUseCases } from "@/lib/container";
import { handleTeamsActivityRequest } from "../_lib/handleActivityRequest";

type RouteContext = { params: Promise<{ agent: string }> };

/**
 * Per-agent Teams messaging endpoint. Each agent-dedicated Azure Bot has
 * this URL as its messaging endpoint; every delivery carries a token the Bot
 * Framework signed for that bot's App ID, so routing is unambiguous and
 * authentication IS the token. No session is involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { agent: agentName } = await ctx.params;
  const bound = await agentTeamsUseCases.resolveEventBinding(agentName);
  if (!bound) {
    return Response.json({ error: "Teams is not configured for this agent" }, { status: 404 });
  }
  return handleTeamsActivityRequest(request, bound);
}
