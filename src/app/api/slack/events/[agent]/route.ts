import { agentSlackUseCases } from "@/lib/container";
import { handleSlackEventRequest } from "../_lib/handleEventRequest";

type RouteContext = { params: Promise<{ agent: string }> };

/**
 * Per-agent Slack Events endpoint. Each agent-dedicated bot points its
 * Events API request URL here; the signature is verified with that agent's
 * own signing secret, so routing is unambiguous. Authentication IS the
 * signature — no session is involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { agent: agentName } = await ctx.params;
  const bound = await agentSlackUseCases.resolveEventBinding(agentName);
  if (!bound) {
    return Response.json({ error: "Slack is not configured for this agent" }, { status: 404 });
  }
  return handleSlackEventRequest(request, {
    signingSecret: bound.signingSecret,
    binding: { agentName: bound.agentName, botToken: bound.botToken },
    logLabel: `agent ${bound.agentName}`,
    engagement: { keywords: bound.channelKeywords },
  });
}
