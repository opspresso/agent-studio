import { withAdminAuth } from "@/lib/session";
import { usageUseCases } from "@/lib/container";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { summaryQuerySchema } from "../summary/validation";

export type MembersUsageResponse = Awaited<ReturnType<typeof usageUseCases.members>>;

export const GET = withAdminAuth(async (_user, request: Request) => {
  const params = new URL(request.url).searchParams;
  const parsed = summaryQuerySchema.safeParse({ from: params.get("from"), to: params.get("to") });
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    return Response.json(await usageUseCases.members(parsed.data.from, parsed.data.to) satisfies MembersUsageResponse);
  } catch (error) { return apiError(error); }
});
