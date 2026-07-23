import { projectRepository } from "@/lib/container";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
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
  const project = await projectRepository.get(projectName);
  const runtime = project ? resolveProjectSlackRuntime(project) : null;
  if (!project || !runtime) {
    return Response.json({ error: "Slack is not configured for this project" }, { status: 404 });
  }
  return handleSlackEventRequest(request, {
    signingSecret: runtime.signingSecret,
    binding: { projectName: project.name, botToken: runtime.botToken },
    logLabel: `project ${project.name}`,
  });
}
