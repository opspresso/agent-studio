import { withAuth } from "@/lib/session";
import { agentSlackUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await agentSlackUseCases.test(name, user.email);
    if (!result.ok) {
      return Response.json(
        { error: "Slack is not configured or not enabled for this agent" },
        { status: 400 },
      );
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Slack ")) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return apiError(error);
  }
});
