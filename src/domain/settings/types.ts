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
  /** Display branding; absent values fall back to SERVICE_NAME/SERVICE_LOGO. */
  serviceName?: string;
  serviceLogo?: string;
  registeredModels?: import("../llm/providerModels").RegisteredModel[];
  defaultModel?: string;
  adminEmails?: string;
  allowedEmailDomains?: string;
  /** When set, replaces the whole LLM_PROVIDER_* env-derived provider list. */
  llmProviders?: LlmProviderSetting[];
  /** Active capability-catalog embedding model; absent means no model selected. */
  embeddingModel?: string;
  /** Native Workspace runtime models selected in Models; no environment fallback. */
  workspaceModels?: import("../workspace/types").WorkspaceRuntimeModels;
  /** Active capability-catalog reranker; absent disables reranking. */
  rerankerModel?: string;
  /** Shared decision model for Agent suggestions and focused-call model routing. */
  decisionModel?: string;
  /** Shared tier assignments and execution constraints; Agents store only an opt-in. */
  modelRouting?: import("../llm/callRouting").CallRoutingPolicy;
  /** Reranker relevance floor; absent falls back to RERANKER_MIN_SCORE. */
  rerankerMinScore?: string;
  pluginsRepo?: string;
  pluginsRepoBranch?: string;
  /** Secret. */
  githubToken?: string;
  /** Secret. */
  publicBaseUrl?: string;
  /** An {@link ArtifactAccessMode} (`authenticated` by default); controls how stored artifact URLs are resolved. */
  artifactAccessMode?: string;
  /**
   * `allow` (the default) or `refuse` — whether a run may execute a model the
   * registry cannot price. Stored as the raw string like every other field;
   * `toUnknownModelPolicy` is what reads it.
   */
  unknownModelPolicy?: string;
  /** Capability search score floor; absent falls back to CATALOG_MIN_SCORE. */
  catalogMinScore?: string;
  /** Caller run-slot ceiling; absent falls back to MAX_CONCURRENT_RUNS_PER_ACTOR. */
  maxConcurrentRunsPerActor?: string;
  /** Public object delivery address; absent falls back to S3_PUBLIC_BASE_URL. */
  s3PublicBaseUrl?: string;
  /** Slack edit-in-place progress marker; absent falls back to SLACK_LOADING_INDICATOR. */
  slackLoadingIndicator?: string;
  updatedAt: string;
}
