import { auditUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";
import { utcDay } from "@/shared/date";
import { parsePageLimit } from "@/shared/pageLimit";
import { AUDIT_PAGE_SIZE } from "@/application/audit/auditUseCases";

/**
 * The audit trail, a UTC day range at a time. Admin-only: the rows name people.
 *
 * Read-only by construction — there is no write verb here and none anywhere
 * else. Rows are appended by the acts themselves and expire by TTL; a record its
 * subject could amend would not be one.
 */
export const GET = withAdminAuth(async (_user, request: Request) => {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? utcDay(new Date());
  const to = url.searchParams.get("to");
  const cursor = url.searchParams.get("cursor");
  const pageSize = parsePageLimit(url.searchParams.get("limit"), { fallback: AUDIT_PAGE_SIZE, max: AUDIT_PAGE_SIZE });
  try {
    return Response.json(await auditUseCases.list({ from, ...(to ? { to } : {}),
      ...(cursor !== null ? { cursor } : {}), limit: pageSize.limit }));
  } catch (error) {
    return apiError(error);
  }
});
