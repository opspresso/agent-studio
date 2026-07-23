/**
 * Global app settings stored as a single item. Every field is an optional
 * override of the matching environment variable — absent means "fall back to
 * env". Values are kept in their raw env string form (comma-separated lists
 * stay comma-separated). Secret fields hold `enc:v1:` ciphertext at rest.
 */
/** One per-provider LLM channel override (replaces the LLM_PROVIDER_* env set). */
export interface LlmProviderSetting {
  /** Lowercase provider key matching the model id prefix (e.g. "openai"). */
  name: string;
  baseUrl: string;
  /** Secret (enc:v1: at rest). */
  apiKey: string;
  keepModelPrefix?: boolean;
}

export interface AppSettings {
  adminEmails?: string;
  allowedEmailDomains?: string;
  llmBaseUrl?: string;
  /** Secret. */
  llmApiKey?: string;
  /** When set, replaces the whole LLM_PROVIDER_* env-derived provider list. */
  llmProviders?: LlmProviderSetting[];
  skillsRepo?: string;
  skillsRepoBranch?: string;
  /** Secret. */
  githubToken?: string;
  /** Secret. */
  a2aApiKey?: string;
  publicBaseUrl?: string;
  updatedAt: string;
}
