import { agentTelegramUseCases } from "@/lib/container";
import { handleTelegramUpdateRequest } from "../_lib/handleUpdateRequest";

type RouteContext = { params: Promise<{ agent: string }> };

/**
 * Per-agent Telegram webhook. Each agent-dedicated bot is registered with
 * this URL and its own secret token, which Telegram echoes on every delivery —
 * so routing is unambiguous and authentication IS the secret. No session is
 * involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { agent: agentName } = await ctx.params;
  const bound = await agentTelegramUseCases.resolveEventBinding(agentName);
  if (!bound) {
    return Response.json({ error: "Telegram is not configured for this agent" }, { status: 404 });
  }
  return handleTelegramUpdateRequest(request, bound);
}
