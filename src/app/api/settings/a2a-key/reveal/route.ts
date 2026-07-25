import { apiError } from "@/app/api/_lib/http";
import { NotFoundError } from "@/application/errors";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";

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
    // Secret access is worth a trail even when it is authorized.
    console.warn(`[settings] A2A_API_KEY revealed by ${user.email}`);
    return Response.json({ key });
  } catch (error) {
    return apiError(error);
  }
});
