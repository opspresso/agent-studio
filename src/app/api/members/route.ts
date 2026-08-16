import { memberUseCases } from "@/lib/container";
import { isConfiguredAdmin } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { apiError } from "@/app/api/_lib/http";

export const GET = withAdminAuth(async () => {
  try {
    const members = await memberUseCases.list();
    return Response.json({
      members: await Promise.all(members.map(async (member) => ({
        ...member,
        tierLocked: await isConfiguredAdmin(member.email),
      }))),
    });
  } catch (error) {
    return apiError(error);
  }
});
