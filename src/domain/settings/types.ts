/**
 * Global app settings stored as a single item. Every field is an optional
 * override of the matching environment variable — absent means "fall back to
 * env". Values are kept in their raw env string form (comma-separated lists
 * stay comma-separated). Secret fields hold `enc:v1:` ciphertext at rest.
 */
/**
 * How a channel proves who it is.
 *
 * `bearer` is every OpenAI-compatible endpoint: a key in an `Authorization`
 * header. `sigv4` is AWS's request signing, which carries no key at all — the
 * pod's own identity is the credential, so a `sigv4` channel is configured
 * with a base URL and nothing else.
 */
export type ChannelAuth = "bearer" | "sigv4";

/** One per-provider LLM channel override (replaces the LLM_PROVIDER_* env set). */
export interface LlmProviderSetting {
  /** Lowercase provider key matching the model id prefix (e.g. "openai"). */
  name: string;
  baseUrl: string;
  /** Secret (enc:v1: at rest). Empty for `sigv4`, which has no key. */
  apiKey: string;
  keepModelPrefix?: boolean;
  /** Absent means `bearer` — the form every stored row predating this had. */
  auth?: ChannelAuth;
}

export type ArtifactAccessMode = "authenticated" | "public";

/**
 * One deployment-declared self-hosted model, stored as the full catalog-shaped
 * entry the registry loader validates (`loadSelfHostedModels`). The deployment
 * is the publisher here — these models exist only where an operator runs the
 * serving stack, so their facts live in this row rather than in agent-models.
 * The shape is the registry's (`domain/llm/models.ts`), because that is who
 * reads it back.
 */
export type SelfHostedModelSetting = import("../llm/selfHostedModels").SelfHostedModelDeclaration;

export interface AppSettings {
  adminEmails?: string;
  allowedEmailDomains?: string;
  llmBaseUrl?: string;
  /** Secret. */
  llmApiKey?: string;
  /** When set, replaces the whole LLM_PROVIDER_* env-derived provider list. */
  llmProviders?: LlmProviderSetting[];
  pluginsRepo?: string;
  pluginsRepoBranch?: string;
  /** Secret. */
  githubToken?: string;
  /** Secret. */
  a2aApiKey?: string;
  publicBaseUrl?: string;
  /** `authenticated` (default) or `public`; controls how stored artifact URLs are resolved. */
  artifactAccessMode?: string;
  /**
   * `allow` (the default) or `refuse` — whether a run may execute a model the
   * registry cannot price. Stored as the raw string like every other field;
   * `toUnknownModelPolicy` is what reads it.
   */
  unknownModelPolicy?: string;
  /**
   * When set, only these registry model ids are offered for selection (the
   * /api/models list and every dropdown it feeds). Absent means every visible
   * model. Selection-time only — a version already holding a disabled model
   * keeps running.
   */
  enabledModels?: string[];
  /**
   * Self-hosted models this deployment declares (the deployment is their
   * publisher — agent-models carries external routes only). Installed into the
   * registry overlay on save and on every catalog refresh tick.
   */
  selfHostedModels?: SelfHostedModelSetting[];
  updatedAt: string;
}

/** An LLM provider channel resolved from settings or the environment. */
export interface ProviderChannelConfig {
  /** Lowercase provider key matching the model id prefix (e.g. "openai"). */
  name: string;
  baseUrl: string;
  /** Empty when `auth` is `sigv4`. */
  apiKey: string;
  keepModelPrefix: boolean;
  auth: ChannelAuth;
}
