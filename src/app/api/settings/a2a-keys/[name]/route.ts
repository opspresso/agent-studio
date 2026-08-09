import { a2aClientKeyUseCases } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

type RouteContext = { params: Promise<{ name: string }> };

/** Revoke a client key. The client's runs stop authenticating immediately. */
export const DELETE = withAdminAuth(async (user, _request, ctx: RouteContext) => {
  try {
    const name = parseName((await ctx.params).name);
    await a2aClientKeyUseCases.revoke(name, user.email);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
});
