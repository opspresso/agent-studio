import { auditUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

/**
 * The audit trail, a UTC day range at a time. Admin-only: the rows name people.
 *
 * Read-only by construction — there is no write verb here and none anywhere
 * else. Rows are appended by the acts themselves and expire by TTL; a record its
 * subject could amend would not be one.
 */
export const GET = withAdminAuth(async (_user, request: Request) => {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
  const to = url.searchParams.get("to");
  try {
    const events = await auditUseCases.list({ from, ...(to ? { to } : {}) });
    return Response.json({ events });
  } catch (error) {
    return apiError(error);
  }
});
