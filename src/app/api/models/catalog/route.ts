import { getVisibleModels, SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { getEnabledModels, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withAdminAuth } from "@/lib/session";

/**
 * GET /api/models/catalog — the /models console's full picture: every visible
 * model with its enabled flag (admin-only, because it lists exactly what
 * /api/models hides), and which providers this deployment can dispatch to.
 */
export const GET = withAdminAuth(async () => {
  const [providerConfigs, enabledModels] = await Promise.all([
    getLlmProviderConfigs(),
    getEnabledModels(),
  ]);
  const dedicated = new Set(providerConfigs.map((provider) => provider.name));
  const enabled = enabledModels === undefined ? undefined : new Set(enabledModels);
  return Response.json({
    providers: SUPPORTED_PROVIDERS.map((name) => ({
      name,
      // With no dedicated channels the default channel dispatches every id.
      available: dedicated.size === 0 || dedicated.has(name),
      dedicated: dedicated.has(name),
    })),
    models: getVisibleModels().map((model) => ({
      ...model,
      enabled: enabled === undefined || enabled.has(model.id),
    })),
    source: enabled === undefined ? "default" : "override",
  });
});
