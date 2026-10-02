import { z } from "zod";
import { headerRecordSchema } from "@/app/api/_lib/headerRecord";
import { mcpAuthUseCases } from "@/lib/container";
import { withMemberAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";
import { editorBody } from "@/app/api/_lib/body";

type RouteContext = { params: Promise<{ name: string; server: string }> };

const bodySchema = z.object({
  /** The binding's own header layer, so the answer matches what a run offers. */
  headerOverrides: headerRecordSchema(z.string().nullable()).optional(),
});

/** List tools with the caller's personal OAuth grant and the current Agent binding. */
export const POST = withMemberAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  // An empty body is a valid request: a binding with no overrides sends none.
  const body = await editorBody(request, { empty: {} });
  if (body instanceof Response) {
    return body;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const result = await mcpAuthUseCases.listTools(
      parseName(name),
      parseName(server),
      { userId: user.id, email: user.email },
      parsed.data.headerOverrides,
      );
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 502 });
    }
    return Response.json({ tools: result.tools });
  } catch (error) {
    return apiError(error);
  }
});
