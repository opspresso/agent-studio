import { withAuth } from "@/lib/session";
import { isEffectiveConfiguredAdmin } from "@/lib/memberAccess";
import { agentUseCases } from "@/lib/container";
import { agentNameSchema, updateAgentSchema } from "@/app/api/agents/_lib/schemas";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sanitizeAgent } from "@/app/api/agents/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    const agent = await agentUseCases.assertAccessible(name, user.email);
    // The invite list travels only to whoever manages the agent — the same
    // pair `assertAgentWritable` admits — because it is a roster of other
    // people's addresses, not part of what "seeing the agent" grants.
    const manages =
      agent.ownerEmail === user.email || (await isEffectiveConfiguredAdmin(user));
    return Response.json(sanitizeAgent(agent, { withMemberEmails: manages }));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateAgentSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // The update is owner-or-admin gated, so whoever got this far manages the
    // agent and may see the normalized invite list they just wrote.
    return Response.json(
      sanitizeAgent(await agentUseCases.update(name, parsed.data, user.email), {
        withMemberEmails: true,
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  if (!agentNameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid agent name" }, { status: 400 });
  }
  try {
    await agentUseCases.remove(name, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
