import { withAuth } from "@/lib/session";
import { triggerUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { createTriggerSchema } from "@/app/api/projects/_lib/schemas";

type RouteContext = { params: Promise<{ name: string }> };

export const GET = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    return Response.json({ triggers: await triggerUseCases.list(name, user.email) });
  } catch (error) {
    return apiError(error);
  }
});

export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const parsed = createTriggerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    // The response carries the secret in the clear — the only time it is
    // readable, like a freshly issued project API token.
    return Response.json(await triggerUseCases.create(name, parsed.data, user.email), {
      status: 201,
    });
  } catch (error) {
    return apiError(error);
  }
});
