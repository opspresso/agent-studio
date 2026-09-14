import { z } from "zod";
import { mcpAuthUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string }> };

const discoverSchema = z.object({
  /** Answers a previous `choose` result; must be one the resource advertised. */
  authorizationServer: z.string().url().optional(),
});

const clientSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().optional(),
});

/**
 * Discover and store what an OAuth flow against this server needs. Admin-only:
 * the registry entry is shared, so its endpoints and OAuth client are operator
 * configuration; projects only perform their own owner-gated authorization.
 */
export const POST = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request, { empty: {} });
  if (body instanceof Response) {
    return body;
  }
  const parsed = discoverSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await mcpAuthUseCases.discover(parseName(name), {
        ...(parsed.data.authorizationServer
          ? { authorizationServer: parsed.data.authorizationServer }
          : {}),
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});

/** Save the OAuth app credentials shared by projects using this MCP entry. */
export const PUT = withAdminAuth(async (_user, request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  const body = await editorBody(request, { empty: {} });
  if (body instanceof Response) {
    return body;
  }
  const parsed = clientSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await mcpAuthUseCases.saveOAuthClientCredentials(parseName(name), parsed.data),
    );
  } catch (error) {
    return apiError(error);
  }
});

/** Return the entry to static-header behaviour. */
export const DELETE = withAdminAuth(async (_user, _request: Request, ctx: RouteContext) => {
  const { name } = await ctx.params;
  try {
    await mcpAuthUseCases.clearAuth(parseName(name));
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
