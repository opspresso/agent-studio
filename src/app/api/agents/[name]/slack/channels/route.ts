import { apiError } from "@/app/api/_lib/http";
import { agentSlackUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import type { SlackChannelListing } from "@/domain/slack/reader";

export type SlackChannelsResponse = SlackChannelListing;

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await agentSlackUseCases.channels(name, user.email) satisfies SlackChannelsResponse);
  } catch (error) {
    return apiError(error);
  }
});
