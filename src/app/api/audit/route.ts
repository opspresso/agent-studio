import { auditRepository } from "@/lib/container";
import { listAuditEvents } from "@/application/audit/listAuditEvents";
import { apiError } from "@/app/api/_lib/http";
import { withNamedAdminAuth } from "@/lib/session";

/**
 * The audit trail for a date range.
 *
 * A *named* admin, which is stricter than the rest of the admin surface: these
 * rows say who revealed which credential and when, and who overrode whose
 * project. `withAdminAuth`'s "an empty `ADMIN_EMAILS` means no restriction"
 * would hand all of that to every signed-in address on a deployment that never
 * configured one — the same reason the sibling secret routes were moved off it.
 * The rows are the *workspace's* own, though, so a workspace admin reads
 * theirs; what is refused is the fail-open, not the role.
 *
 * Both dates are required rather than defaulted — the rows are partitioned by
 * UTC day and read one Query per day, so a caller who did not say how far back
 * they meant should be told, not served a guess.
 */
export const GET = withNamedAdminAuth(async (_user, request: Request) => {
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
