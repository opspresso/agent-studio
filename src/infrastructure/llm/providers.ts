/** Resolve a selected model to its registered provider connection. */

import { getModelConfig, wireModelId } from "@/domain/llm/models";
import { providerBaseUrl, providerKind } from "@/domain/llm/providerModels";
import { optionalEnv } from "@/shared/env";
import type { ChannelAuth, ProviderChannelConfig } from "@/domain/settings/types";
export type { ProviderChannelConfig };

/** Resolves a model id to the channel that serves it. Injected into the adapters. */
export type TargetResolver = (modelId: string) => Promise<ResolvedTarget>;

export interface ResolvedTarget {
  /** null means the default channel. */
  providerName: string | null;
  baseUrl: string;
  /** Empty when `auth` is `sigv4`. */
  apiKey: string;
  auth: ChannelAuth;
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
    // Anything other than the one recognised value reads as `bearer`, so a
    // typo cannot turn a keyed channel into an unsigned one — it fails the
    // key check below instead, which says what is missing.
    const auth: ChannelAuth =
      optionalEnv(env[`LLM_PROVIDER_${upperName}_AUTH`]) === "sigv4" ? "sigv4" : "bearer";
    // A `sigv4` channel has no key to require: AWS signs with the pod's own
    // credentials. Demanding one here is what kept Bedrock from registering at
    // all — silently, since an unregistered provider just falls through to the
    // default channel and 404s there.
    if (auth === "bearer" && !apiKey) {
      continue;
    }
    configs.push({
      name: upperName.toLowerCase(),
      baseUrl,
      apiKey: apiKey ?? "",
      auth,
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
): ResolvedTarget {
  const model = getModelConfig(modelId);
  if (!model) throw new Error(`Model is not selected for this installation: ${modelId}`);
  const provider = providers.find(item => item.name === model.provider);
  if (!provider) throw new Error(`Provider is not registered: ${model.provider}`);
  const kind = providerKind(provider);
  const base = providerBaseUrl(provider.baseUrl);
  return {
    providerName: kind,
    baseUrl: kind === "google" && !base.endsWith("/openai") ? `${base}/openai` : base,
    apiKey: provider.apiKey || "not-required",
    auth: provider.auth,
    model: provider.keepModelPrefix ? modelId : wireModelId(modelId),
  };
}
