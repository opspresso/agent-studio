import { withAuth, withMemberAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import type { AgentCredentialUseCases } from "@/application/auth/agentCredentialUseCases";

type RouteContext = { params: Promise<{ name: string }> };
const privateResponse = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });

/** Both purposes always select the session user's credential; request bodies cannot choose another issuer. */
export function createCredentialRoutes(tokens: Pick<AgentCredentialUseCases, "status" | "generate" | "reveal" | "revoke">) {
  return {
    GET: withAuth(async (user, _request: Request, ctx: RouteContext) => {
      const { name } = await ctx.params;
      try { return privateResponse(await tokens.status(name, user.id)); }
      catch (error) { return apiError(error); }
    }),
    POST: withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
      const { name } = await ctx.params;
      try { return privateResponse(await tokens.generate(name, user.id)); }
      catch (error) { return apiError(error); }
    }),
    DELETE: withAuth(async (user, _request: Request, ctx: RouteContext) => {
      const { name } = await ctx.params;
      try { await tokens.revoke(name, user.id); return new Response(null, { status: 204 }); }
      catch (error) { return apiError(error); }
    }),
    REVEAL: withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
      const { name } = await ctx.params;
      try { return privateResponse(await tokens.reveal(name, user.id)); }
      catch (error) { return apiError(error); }
    }),
  };
}
