import { withAuth } from "@/lib/session";
import { projectRepository } from "@/lib/container";
import { getProject } from "@/application/project/projectUseCases";
import { resolveProjectSlackRuntime } from "@/application/slack/projectSlack";
import { slackClient } from "@/infrastructure/slack/client";
import { apiError } from "@/app/api/projects/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const project = await getProject(projectRepository, name);
    const runtime = resolveProjectSlackRuntime(project);
    if (!runtime) {
      return Response.json(
        { error: "Slack is not configured or not enabled for this project" },
        { status: 400 },
      );
    }
    const identity = await slackClient.authTest(runtime.botToken);
    return Response.json({ ok: true, team: identity.team, botUser: identity.user });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Slack ")) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return apiError(error);
  }
});
