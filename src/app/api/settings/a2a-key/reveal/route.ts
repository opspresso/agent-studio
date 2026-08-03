import { apiError } from "@/app/api/_lib/http";
import { NotFoundError } from "@/application/errors";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/**
 * Return the effective A2A API key in plaintext — the stored override decrypted,
 * or the env value when there is no override. Admin-only, like every other
 * settings read of a secret.
 *
 * A POST rather than a GET even though it reads: the response body is a live
 * credential, and POST keeps it out of prefetches, history and caches.
 */
export const POST = withAdminAuth(async (user) => {
  try {
    const key = await getA2aApiKey();
    if (!key) {
      throw new NotFoundError("A2A_API_KEY is not configured");
    }
    // Secret access is worth a trail even when it is authorized. The line and
    // the row are both kept: the row is queryable, the line is what remains if
    // the audit store is the thing that failed.
    log.warn("settings", `A2A_API_KEY revealed by ${user.email}`);
    await recordAudit({
      actorEmail: user.email,
      action: "secret.reveal",
      target: auditTarget("settings", "app"),
      detail: "A2A_API_KEY",
    });
    return Response.json({ key });
  } catch (error) {
    return apiError(error);
  }
});
