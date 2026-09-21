/** Deployment settings, provider connections and selected models share one atomic settings item.
 * Secrets are encrypted at rest. Model selections are DB-owned; environment-backed settings
 * retain their documented fallback semantics. */
import type { ChannelAuth } from "../llm/providerModels";
export type { ChannelAuth, ProviderChannelConfig } from "../llm/providerModels";

/** One per-provider LLM channel override (replaces the LLM_PROVIDER_* env set). */
export interface LlmProviderSetting {
  kind?: import("../llm/models").SupportedProvider;
  /** Lowercase provider key matching the model id prefix (e.g. "openai"). */
  name: string;
  baseUrl: string;
  /** Secret (enc:v1: at rest). Empty for `sigv4`, which has no key. */
  apiKey: string;
  keepModelPrefix?: boolean;
  /** Absent means `bearer` — the form every stored row predating this had. */
  auth?: ChannelAuth;
}

/**
 * How a stored artifact's address is answered. `authenticated` and `public`
 * hand out the store's own address (pre-signed, or direct); `proxied` hands
 * out this app's, for a deployment whose store nobody but the app can reach.
 */
export type ArtifactAccessMode = "authenticated" | "public" | "proxied";

export interface AppSettings {
  registeredModels?: import("../llm/providerModels").RegisteredModel[];
  defaultModel?: string;
  adminEmails?: string;
  allowedEmailDomains?: string;
  llmBaseUrl?: string;
  /** Secret. */
  llmApiKey?: string;
  /** When set, replaces the whole LLM_PROVIDER_* env-derived provider list. */
  llmProviders?: LlmProviderSetting[];
  /** Active capability-catalog embedding model; absent means no model selected. */
  embeddingModel?: string;
  /** Native Workspace runtime models selected in Models; no environment fallback. */
  workspaceModels?: import("../workspace/types").WorkspaceRuntimeModels;
  /** Active capability-catalog reranker; absent disables reranking. */
  rerankerModel?: string;
  /** Reranker relevance floor; absent falls back to RERANKER_MIN_SCORE. */
  rerankerMinScore?: string;
  pluginsRepo?: string;
  pluginsRepoBranch?: string;
  /** Secret. */
  githubToken?: string;
  /** Secret. */
  a2aApiKey?: string;
  publicBaseUrl?: string;
  /** An {@link ArtifactAccessMode} (`authenticated` by default); controls how stored artifact URLs are resolved. */
  artifactAccessMode?: string;
  /**
   * `allow` (the default) or `refuse` — whether a run may execute a model the
   * registry cannot price. Stored as the raw string like every other field;
   * `toUnknownModelPolicy` is what reads it.
   */
  unknownModelPolicy?: string;
  updatedAt: string;
}
