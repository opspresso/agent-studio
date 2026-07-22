import { getVisibleModels } from "@/domain/llm/models";
import { getLlmProviderConfigs } from "@/lib/runtime-settings";
import { withAuth } from "@/lib/session";

/**
 * GET /api/models — visible (non-hidden) model configs for the console.
 * With per-provider LLM channels configured (settings override or
 * LLM_PROVIDER_* env), only those providers' models are listed; with none,
 * every model is listed (the default channel dispatches all ids).
 */
export const GET = withAuth(async () => {
  const providers = new Set((await getLlmProviderConfigs()).map((provider) => provider.name));
  const models =
    providers.size === 0
      ? getVisibleModels()
      : getVisibleModels().filter((model) => providers.has(model.provider));
  return Response.json({ models });
});
