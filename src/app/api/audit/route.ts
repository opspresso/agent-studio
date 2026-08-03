import { auditRepository } from "@/lib/container";
import { listAuditEvents } from "@/application/audit/listAuditEvents";
import { apiError } from "@/app/api/_lib/http";
import { withAdminAuth } from "@/lib/session";

/**
 * The audit trail for a date range. Admin-only: these rows name individuals and
 * the credentials they touched, which is precisely what a shared catalog's
 * ordinary reads are open about and this is not.
 *
 * Both dates are required rather than defaulted — the rows are partitioned by
 * UTC day and read one Query per day, so a caller who did not say how far back
 * they meant should be told, not served a guess.
 */
export const GET = withAdminAuth(async (_user, request: Request) => {
  const params = new URL(request.url).searchParams;
  try {
    // `truncated` rides along rather than being left to the reader to notice: a
    // page that stops at the cap looks like a range that ended there.
    return Response.json(
      await listAuditEvents(auditRepository, {
        from: params.get("from") ?? "",
        to: params.get("to") ?? "",
      }),
    );
  } catch (error) {
    return apiError(error);
  }
});
