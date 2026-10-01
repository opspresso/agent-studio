import { z } from "zod";
import { memberTierUseCases } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { invalidateMemberTierCache } from "@/lib/memberAccess";
import { MAX_MEMBER_TIERS, MEMBER_TIER_ID } from "@/domain/member/tiers";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";

const schema = z.object({
  revision: z.number().int().nonnegative(),
  tiers: z.array(z.object({ id: z.string().regex(MEMBER_TIER_ID), monthlyCostCapUsd: z.number().finite().nonnegative().nullable() }).strict()).min(2).max(MAX_MEMBER_TIERS),
}).strict();
export type MemberTiersResponse = Awaited<ReturnType<typeof memberTierUseCases.getView>>;

export const GET = withAdminAuth(async () => {
  try { return Response.json(await memberTierUseCases.getView() satisfies MemberTiersResponse); }
  catch (error) { return apiError(error); }
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const view = await memberTierUseCases.update(parsed.data, user.email);
    invalidateSettingsCache();
    invalidateMemberTierCache();
    return Response.json(view satisfies MemberTiersResponse);
  } catch (error) { return apiError(error); }
});
