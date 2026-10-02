import { z } from "zod";
import { mcpAuthUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string; server: string }> };

const saveSchema = z.object({
  clientId: z.string().min(1),
  /** Omitted/masked preserves a secret only for the same client and issuer; empty clears it. */
  clientSecret: z.string().optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

export const PUT = withMemberAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  const body = await editorBody(request);
  if (body instanceof Response) {
    return body;
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    return Response.json(
      await mcpAuthUseCases.saveClientCredentials(
        parseName(name),
        parseName(server),
        parsed.data,
        { userId: user.id, email: user.email },
      ),
    );
  } catch (error) {
    return apiError(error);
  }
});

export const DELETE = withMemberAuth(async (user, _request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  try {
    await mcpAuthUseCases.disconnect(parseName(name), parseName(server), { userId: user.id, email: user.email });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
});
