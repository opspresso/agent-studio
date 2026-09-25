import { withAuth } from "@/lib/session";
import { agentTeamsUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

/** Prove the stored registration works by acquiring a token with it. */
export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const result = await agentTeamsUseCases.test(name, user.email);
    if (!result.ok) {
      return Response.json(
        { error: "Teams is not configured or not enabled for this agent" },
        { status: 400 },
      );
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Teams ")) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    return apiError(error);
  }
});
