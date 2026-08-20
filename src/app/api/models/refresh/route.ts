import { modelCatalogUpdatedAt } from "@/domain/llm/models";
import { refreshModelCatalog } from "@/lib/container";
import { withAdminAuth } from "@/lib/session";

/**
 * POST /api/models/refresh — pull the published catalog now rather than on
 * the hourly tick, for the moment right after agent-models publishes.
 *
 * `refreshed: false` covers both "already current" and "could not fetch" —
 * the refresher reports the reason to the log, and either way the registry
 * is unchanged, which with `updatedAt` beside it is the answer the console's
 * question ("am I current?") actually needs. Never a 5xx: like the model
 * probe, a refresh that installed nothing is a finding, not a failure.
 */
export const POST = withAdminAuth(async () => {
  const refreshed = await refreshModelCatalog();
  return Response.json({ refreshed, updatedAt: modelCatalogUpdatedAt() });
});
