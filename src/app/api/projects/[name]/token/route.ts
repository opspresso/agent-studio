import { withAuth } from "@/lib/session";
import { projectRepository, secretCipher } from "@/lib/container";
import {
  generateApiToken,
  getApiTokenStatus,
  revokeApiToken,
} from "@/application/project/apiTokenUseCases";
import { apiError } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await getApiTokenStatus(projectRepository, name, user.email));
  } catch (error) {
    return apiError(error);
  }
});

export const POST = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    // Returns the raw token once; only its hash is stored.
    return Response.json(await generateApiToken(projectRepository, name, user.email, secretCipher));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    await revokeApiToken(projectRepository, name, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
