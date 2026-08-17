import { projectTeamsUseCases } from "@/lib/container";
import { handleTeamsActivityRequest } from "../_lib/handleActivityRequest";

type RouteContext = { params: Promise<{ project: string }> };

/**
 * Per-project Teams messaging endpoint. Each project-dedicated Azure Bot has
 * this URL as its messaging endpoint; every delivery carries a token the Bot
 * Framework signed for that bot's App ID, so routing is unambiguous and
 * authentication IS the token. No session is involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { project: projectName } = await ctx.params;
  const bound = await projectTeamsUseCases.resolveEventBinding(projectName);
  if (!bound) {
    return Response.json({ error: "Teams is not configured for this project" }, { status: 404 });
  }
  return handleTeamsActivityRequest(request, bound);
}
