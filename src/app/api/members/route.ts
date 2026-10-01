import { memberUseCases } from "@/lib/container";
import { getMemberTierDefinitions, isConfiguredAdmin } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";
import type { Member } from "@/domain/member/types";

export interface MembersResponse {
  members: Array<Member & { tierLocked: boolean }>;
  tiers: string[];
}

export const GET = withAdminAuth(async () => {
  try {
    const members = await memberUseCases.list();
    return Response.json({
      tiers: (await getMemberTierDefinitions()).map(tier => tier.id),
      members: await Promise.all(members.map(async (member) => ({
        ...member,
        tierLocked: await isConfiguredAdmin(member.email),
      }))),
    } satisfies MembersResponse);
  } catch (error) {
    return apiError(error);
  }
});
