import { projectRepository, secretCipher } from "@/lib/container";
import { resolveSlackEventBinding } from "@/application/slack/projectSlack";
import { handleSlackEventRequest } from "../_lib/handleEventRequest";

type RouteContext = { params: Promise<{ project: string }> };

/**
 * Per-project Slack Events endpoint. Each project-dedicated bot points its
 * Events API request URL here; the signature is verified with that project's
 * own signing secret, so routing is unambiguous. Authentication IS the
 * signature — no session is involved.
 */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { project: projectName } = await ctx.params;
  const bound = await resolveSlackEventBinding(projectRepository, projectName, secretCipher);
  if (!bound) {
    return Response.json({ error: "Slack is not configured for this project" }, { status: 404 });
  }
  return handleSlackEventRequest(request, {
    signingSecret: bound.signingSecret,
    binding: { projectName: bound.projectName, botToken: bound.botToken },
    logLabel: `project ${bound.projectName}`,
  });
}
