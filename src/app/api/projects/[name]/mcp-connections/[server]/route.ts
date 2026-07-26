import { z } from "zod";
import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

const saveSchema = z.object({
  clientId: z.string().min(1),
  /** Omitted or masked keeps the stored secret; empty clears it (public client). */
  clientSecret: z.string().optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

export const PUT = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  const parsed = saveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await mcpAuthUseCases.saveClientCredentials(
        parseName(name),
        parseName(server),
        parsed.data,
        user.email,
      ),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    await mcpAuthUseCases.disconnect(parseName(name), parseName(server), user.email);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
