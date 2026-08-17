import { projectTelegramUseCases } from "@/lib/container";
import { handleTelegramUpdateRequest } from "../_lib/handleUpdateRequest";

type RouteContext = { params: Promise<{ project: string }> };

/**
 * Per-project Telegram webhook. Each project-dedicated bot is registered with
 * this URL and its own secret token, which Telegram echoes on every delivery —
 * so routing is unambiguous and authentication IS the secret. No session is
 * involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { project: projectName } = await ctx.params;
  const bound = await projectTelegramUseCases.resolveEventBinding(projectName);
  if (!bound) {
    return Response.json({ error: "Telegram is not configured for this project" }, { status: 404 });
  }
  return handleTelegramUpdateRequest(request, bound);
}
