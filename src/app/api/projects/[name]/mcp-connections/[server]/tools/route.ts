import { z } from "zod";
import { mcpAuthUseCases } from "@/lib/container";
import { withAuth } from "@/lib/session";
import { apiError, invalidRequest, parseName } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ name: string; server: string }> };

const bodySchema = z.object({
  /** The binding's own header layer, so the answer matches what a run offers. */
  headerOverrides: z.record(z.string(), z.string().nullable()).optional(),
});

/**
 * List a server's tools as this project sees them.
 *
 * Distinct from the registry's own probe, which carries only the entry's static
 * headers: against an OAuth server that can do nothing but 401, because the
 * credential that would answer belongs to the project. Owner-gated for the same
 * reason — it spends the project's connection, and sends the caller's header
 * overrides alongside it. A non-owner falls back to the registry probe.
 */
export const POST = withAuth(async (user, request: Request, ctx: RouteContext) => {
  const { name, server } = await ctx.params;
  // An empty body is a valid request: a binding with no overrides sends none.
  const parsed = bodySchema.safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const result = await mcpAuthUseCases.listTools(
      parseName(name),
      parseName(server),
      user.email,
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
