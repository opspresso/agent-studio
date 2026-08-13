import { offeredModels } from "@/domain/llm/models";
import { getEnabledModels, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

/**
 * GET /api/models — the models this deployment offers for selection. The rule
 * (visible × configured providers × enabled-models override) is
 * `offeredModels` in the domain; this route only feeds it the runtime
 * settings.
 */
export const GET = withAuth(async () => {
  const [providerConfigs, enabledModels] = await Promise.all([
    getLlmProviderConfigs(),
    getEnabledModels(),
  ]);
  const models = offeredModels(
    providerConfigs.map((provider) => provider.name),
    enabledModels,
  );
  return Response.json({ models });
});
