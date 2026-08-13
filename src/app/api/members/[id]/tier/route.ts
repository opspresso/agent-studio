import { z } from "zod";
import { MEMBER_TIERS } from "@/domain/member/tiers";
import { memberUseCases } from "@/lib/container";
import { invalidateMemberTierCache } from "@/lib/memberAccess";
import { withAdminAuth } from "@/lib/session";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

type RouteContext = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  tier: z.enum(MEMBER_TIERS),
});

export const PUT = withAdminAuth(async (user, request: Request, ctx: RouteContext) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidRequest(parsed.error);
  }
  try {
    const { id } = await ctx.params;
    const member = await memberUseCases.setTier({
      id,
      tier: parsed.data.tier,
      actorEmail: user.email,
    });
    // The run-bracket guards read the tier through a short cache; the instance
    // that served this write should not spend the TTL enforcing the old one.
    invalidateMemberTierCache(member.email);
    return Response.json(member);
  } catch (error) {
    return apiError(error);
  }
});
