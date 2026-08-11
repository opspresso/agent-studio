/**
 * Multi-provider channel registry, configured through environment variables.
 *
 * Model ids use the `provider/model` form. When a provider channel is
 * registered via `LLM_PROVIDER_<PROVIDER>_BASE_URL` / `_API_KEY`, requests for
 * that provider's models are dispatched to it; otherwise they fall back to the
 * default channel (`LLM_BASE_URL` / `LLM_API_KEY`).
 *
 * Provider-specific channels are assumed to be the provider's own
 * OpenAI-compatible endpoint, which expects the bare model name — the
 * `provider/` prefix is stripped unless `LLM_PROVIDER_<PROVIDER>_KEEP_MODEL_PREFIX=true`
 * (useful when the channel is itself a router that expects full ids). Stripping
 * the prefix is not always enough to name the model the way its own API does,
 * so the bare id comes from `wireModelId` rather than from string surgery here.
 */

import { wireModelId } from "@/domain/llm/models";
import { optionalEnv } from "@/shared/env";
import type { ProviderChannelConfig } from "@/domain/settings/types";
export type { ProviderChannelConfig };

/** Resolves a model id to the channel that serves it. Injected into the adapters. */
export type TargetResolver = (modelId: string) => Promise<ResolvedTarget>;

export interface ResolvedTarget {
  /** null means the default channel. */
  providerName: string | null;
  baseUrl: string;
  apiKey: string;
  /** Model id to send to the channel. */
  model: string;
}

const PROVIDER_ENV_PATTERN = /^LLM_PROVIDER_([A-Z0-9_]+)_BASE_URL$/;

export function parseProviderConfigs(env: Record<string, string | undefined>): ProviderChannelConfig[] {
  const configs: ProviderChannelConfig[] = [];
  for (const [key, rawBaseUrl] of Object.entries(env)) {
    const match = PROVIDER_ENV_PATTERN.exec(key);
    const baseUrl = optionalEnv(rawBaseUrl);
    if (!match?.[1] || !baseUrl) {
      continue;
    }
    const upperName = match[1];
    const apiKey = optionalEnv(env[`LLM_PROVIDER_${upperName}_API_KEY`]);
    if (!apiKey) {
      continue;
    }
    configs.push({
      name: upperName.toLowerCase(),
      baseUrl,
      apiKey,
      // Trimmed like the pair above: a value mounted from a file arrives with a
      // trailing newline, and `"true\n" === "true"` is false — which would read
      // as an operator asking for the prefix to be stripped.
      keepModelPrefix: optionalEnv(env[`LLM_PROVIDER_${upperName}_KEEP_MODEL_PREFIX`]) === "true",
    });
  }
  return configs;
}

export function resolveProviderTarget(
  modelId: string,
  providers: ProviderChannelConfig[],
  defaultChannel: { baseUrl: string; apiKey: string },
): ResolvedTarget {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const prefix = modelId.slice(0, slash).toLowerCase();
    const provider = providers.find((p) => p.name === prefix);
    if (provider) {
      return {
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.keepModelPrefix ? modelId : wireModelId(modelId),
      };
    }
  }
  return {
    providerName: null,
    baseUrl: defaultChannel.baseUrl,
    apiKey: defaultChannel.apiKey,
    model: modelId,
  };
}
