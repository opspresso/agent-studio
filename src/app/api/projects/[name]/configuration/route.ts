import { withAuth } from "@/lib/session";
import { configurationUseCases } from "@/lib/container";
import { putAgentConfigurationSchema } from "@/app/api/projects/_lib/schemas";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json(await configurationUseCases.getView(name, user.email));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = putAgentConfigurationSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json(await configurationUseCases.put(name, parsed.data, user.email));
  } catch (error) {
    return apiError(error);
  }
});
