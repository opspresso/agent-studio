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
  toolsRepo?: string;
  toolsRepoBranch?: string;
  /** Secret. */
  githubToken?: string;
  /** Secret. */
  a2aApiKey?: string;
  publicBaseUrl?: string;
  /**
   * `allow` (the default) or `refuse`. A model missing from the registry runs
   * either way as far as the provider is concerned — what this decides is
   * whether *this app* dispatches it, given that it cannot price one.
   */
  unknownModelPolicy?: string;
  updatedAt: string;
}

/** An LLM provider channel resolved from settings or the environment. */
export interface ProviderChannelConfig {
  /** Lowercase provider key matching the model id prefix (e.g. "openai"). */
  name: string;
  baseUrl: string;
  apiKey: string;
  keepModelPrefix: boolean;
}

/**
 * The settings a workspace may decide for itself.
 *
 * One list, and deliberately short. Everything absent from it is either
 * infrastructure the process is bound to (`STAGE`, DynamoDB, the boot-required
 * values), app-wide by definition (the inbound A2A key gates the endpoint, not
 * a tenant; the sign-in domain gate decides who may authenticate at all), or
 * answered by membership instead — `adminEmails` inside a workspace is its
 * members, not a string.
 *
 * A row carrying anything else is not an error, it is ignored: the resolution
 * reads through this list, so a key that was never meant to be a tenant's
 * cannot become one by being written.
 */
export const TENANT_OVERRIDABLE_KEYS = [
  // Bring-your-own model access.
  "llmBaseUrl",
  "llmApiKey",
  "llmProviders",
  // A workspace's own skill and tool sources.
  "skillsRepo",
  "skillsRepoBranch",
  "toolsRepo",
  "toolsRepoBranch",
  "githubToken",
  // Whether this workspace runs models it cannot price.
  "unknownModelPolicy",
] as const satisfies ReadonlyArray<keyof AppSettings>;

export type TenantOverridableKey = (typeof TENANT_OVERRIDABLE_KEYS)[number];

/** A workspace's overrides: the same shape, narrowed to what it may decide. */
export type TenantSettings = Pick<AppSettings, TenantOverridableKey> & { updatedAt: string };

/** Drop anything a workspace may not decide, whatever a stored row happens to hold. */
export function pickTenantOverrides(stored: Partial<AppSettings>): Partial<AppSettings> {
  const picked: Partial<AppSettings> = {};
  for (const key of TENANT_OVERRIDABLE_KEYS) {
    const value = stored[key];
    if (value !== undefined) {
      Object.assign(picked, { [key]: value });
    }
  }
  return picked;
}
