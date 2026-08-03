import { tenantSettingsUseCases } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";

/**
 * One workspace's own settings — the layer that sits above the deployment's on
 * the `/settings` page and below nothing.
 *
 * Admin of *this* workspace, which `withAdminAuth` already means: inside a
 * workspace it is the membership role that answers, so there is no second gate
 * to keep in step. The tenant is the caller's own and is never taken from the
 * body — a workspace admin is an admin of theirs, not of one they can name.
 *
 * A write invalidates the settings cache the way the app-level page does, with
 * the same process-local limit: on a multi-instance deployment the change lands
 * elsewhere when those instances' entries expire.
 */
export const GET = withAdminAuth(async (user) => {
  try {
    return Response.json(await tenantSettingsUseCases.getView(user.tenant));
  } catch (error) {
    return apiError(error);
  }
});

export const PUT = withAdminAuth(async (user, request: Request) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }
  try {
    const view = await tenantSettingsUseCases.update(user.tenant, body);
    invalidateSettingsCache();
    return Response.json(view);
  } catch (error) {
    return apiError(error);
  }
});
