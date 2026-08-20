import { getVisibleModels, listModelMakers, modelCatalogUpdatedAt, SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { getEnabledModels, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withMemberAuth } from "@/lib/session";

/**
 * GET /api/models/catalog — the /models console's full picture: every visible
 * model with its enabled flag, and which providers this deployment can
 * dispatch to. Read from the member rung, like the other registries the
 * Intelligence section lists: it names what this deployment can reach,
 * including the models an admin switched off — which a member may see but
 * not pick, since `/api/models` still hides them from the pickers. Changing
 * the selection stays admin's (`PUT /api/settings`), as does the probe.
 *
 * `makers` and `updatedAt` come with the models because they are the
 * catalog's, loaded at runtime: a client cannot import them from a constant
 * that no longer exists.
 */
export const GET = withMemberAuth(async () => {
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
    makers: listModelMakers(),
    updatedAt: modelCatalogUpdatedAt(),
    source: enabled === undefined ? "default" : "override",
  });
});
