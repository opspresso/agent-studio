import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { updateTriggerSchema } from "@/app/api/agents/_lib/schemas";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string; trigger: string }> };

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = updateTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(await triggerUseCases.update(name, trigger, parsed.data, user.email));
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, trigger } = await ctx.params;
  try {
    await triggerUseCases.remove(name, trigger, user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
