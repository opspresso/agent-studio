import { getVisibleModels } from "@/domain/llm/models";
import { getEnabledModels, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

/**
 * GET /api/models — visible (non-hidden) model configs for the console.
 * With per-provider LLM channels configured (settings override or
 * LLM_PROVIDER_* env), only those providers' models are listed; with none,
 * every model is listed (the default channel dispatches all ids). An
 * enabled-models override (managed on /models) then narrows the list to the
 * ids it names — a stale id in the override simply matches nothing.
 */
export const GET = withAuth(async () => {
  const [providerConfigs, enabledModels] = await Promise.all([
    getLlmProviderConfigs(),
    getEnabledModels(),
  ]);
  const providers = new Set(providerConfigs.map((provider) => provider.name));
  const enabled = enabledModels === undefined ? undefined : new Set(enabledModels);
  const models = getVisibleModels().filter(
    (model) =>
      (providers.size === 0 || providers.has(model.provider)) &&
      (enabled === undefined || enabled.has(model.id)),
  );
  return Response.json({ models });
});
