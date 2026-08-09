import { withAuth } from "@/lib/session";
import { pluginUseCases } from "@/lib/container";

/**
 * Installed plugins. Read-only: a plugin is never created or edited from the
 * console — the sync is its only writer — so there is no POST here, and a row
 * goes away through the sync's own remove selection.
 */
export const GET = withAuth(async () => {
  return Response.json(await pluginUseCases.list());
});
