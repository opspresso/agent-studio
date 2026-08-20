import {
  getVisibleModels,
  listModelMakers,
  modelCatalogUpdatedAt,
  providerOffered,
  selfHostedDeclarationIds,
  SUPPORTED_PROVIDERS,
} from "@/domain/llm/models";
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
      available: providerOffered(name, dedicated),
      dedicated: dedicated.has(name),
    })),
    models: getVisibleModels().map((model) => ({
      ...model,
      enabled: enabled === undefined || enabled.has(model.id),
    })),
    makers: listModelMakers(),
    // Which selfhosted models are this deployment's own declarations — the
    // only ones the console's Self-hosted section may edit. A catalog can
    // publish under the prefix too, and those are agent-models' to change.
    declaredSelfHosted: selfHostedDeclarationIds(),
    updatedAt: modelCatalogUpdatedAt(),
    source: enabled === undefined ? "default" : "override",
  });
});
