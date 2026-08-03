import { apiError } from "@/app/api/_lib/http";
import { recordAudit } from "@/application/audit/auditLog";
import { NotFoundError } from "@/application/errors";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { withDeploymentAdminAuth } from "@/lib/session";
import { log } from "@/shared/logger";

/**
 * Return the effective A2A API key in plaintext — the stored override decrypted,
 * or the env value when there is no override. Admin-only, like every other
 * settings read of a secret.
 *
 * A POST rather than a GET even though it reads: the response body is a live
 * credential, and POST keeps it out of prefetches, history and caches.
 */
export const POST = withDeploymentAdminAuth(async (user) => {
  try {
    const key = await getA2aApiKey();
    if (!key) {
      throw new NotFoundError("A2A_API_KEY is not configured");
    }
    // Secret access is worth a trail even when it is authorized — one for
    // whoever is watching the logs now, one for whoever asks in six months.
    log.warn("settings", `A2A_API_KEY revealed by ${user.email}`);
    await recordAudit({
      action: "secret.reveal",
      actorEmail: user.email,
      target: "settings:a2a-key",
    });
    return Response.json({ key });
  } catch (error) {
    return apiError(error);
  }
});
