import { settingsUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { generateSecretValue } from "@/shared/generatedSecret";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/**
 * Issue (or reissue) the app-wide A2A API key. Admin-only, like every settings
 * write. The raw key comes back once so it can be handed to callers; afterwards
 * the settings view only ever shows it masked.
 *
 * Reissuing invalidates the previous key immediately — inbound A2A callers must
 * be updated before the old one stops working.
 */
export const POST = withAdminAuth(async (user) => {
  try {
    const key = generateSecretValue("a2aApiKey");
    const view = await settingsUseCases.update({ a2aApiKey: key }, user.email);
    invalidateSettingsCache();
    // A second row beside the `settings.update` the write itself records, and
    // deliberately: that one says which key moved, this one says a credential
    // was rotated. A reader asking "when was anything rotated" filters on the
    // action, and would not find this act under a settings write.
    await recordAudit({
      actorEmail: user.email,
      action: "secret.rotate",
      target: auditTarget("settings", "app"),
      detail: "A2A_API_KEY reissued; the previous key stopped working",
    });
    return Response.json({ key, view });
  } catch (error) {
    return apiError(error);
  }
});
