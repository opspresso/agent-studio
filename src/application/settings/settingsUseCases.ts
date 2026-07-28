import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  AppSettings,
  LlmProviderSetting,
  ProviderChannelConfig,
} from "@/domain/settings/types";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { parseList } from "@/shared/parseList";
import type { SecretCipher } from "@/domain/security/secretCipher";

/** Reads `LLM_PROVIDER_*` env vars into channel configs. Injected. */
export type ParseProviderConfigs = (env: NodeJS.ProcessEnv) => ProviderChannelConfig[];

export type SettingKey = Exclude<keyof AppSettings, "updatedAt" | "llmProviders">;

interface FieldSpec {
  key: SettingKey;
  secret: boolean;
  /** Raw env fallback value (plaintext); `undefined` when the env var is unset. */
  env: () => string | undefined;
  /** Built-in default shown when neither an override nor env is set. */
  defaultValue?: string;
}

/**
 * Env-overridable settings managed on the /settings page. Every fallback reads
 * the injected `env` rather than the `config` singleton: `config` resolves
 * `process.env` at call time, so a spec reaching for it would make the settings
 * view partly uncontrollable — and `config.llmBaseUrl`/`llmApiKey` additionally
 * throw when unset, which a settings *view* must not do.
 */
const fieldSpecs = (env: NodeJS.ProcessEnv): FieldSpec[] => [
  { key: "adminEmails", secret: false, env: () => env.ADMIN_EMAILS || undefined },
  {
    key: "allowedEmailDomains",
    secret: false,
    env: () => env.ALLOWED_EMAIL_DOMAINS || undefined,
  },
  { key: "llmBaseUrl", secret: false, env: () => env.LLM_BASE_URL || undefined },
  { key: "llmApiKey", secret: true, env: () => env.LLM_API_KEY || undefined },
  { key: "skillsRepo", secret: false, env: () => env.SKILLS_REPO || undefined },
  {
    key: "skillsRepoBranch",
    secret: false,
    env: () => env.SKILLS_REPO_BRANCH || undefined,
    defaultValue: "main",
  },
  { key: "githubToken", secret: true, env: () => env.GITHUB_TOKEN || undefined },
  { key: "a2aApiKey", secret: true, env: () => env.A2A_API_KEY || undefined },
  {
    key: "publicBaseUrl",
    secret: false,
    // Same precedence as `config.publicBaseUrl`: the explicit setting wins,
    // then the auth URL, which is set on every deployment that has OAuth.
    env: () => env.PUBLIC_BASE_URL || env.BETTER_AUTH_URL || undefined,
  },
];

export interface SettingFieldView {
  /** Masked for secrets (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4) —
   * never the full plaintext or the ciphertext. */
  value: string;
  source: "override" | "env" | "default" | "unset";
  secret: boolean;
}

export interface LlmProviderView {
  name: string;
  baseUrl: string;
  /** Masked (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4). */
  apiKey: string;
  keepModelPrefix: boolean;
}

export interface SettingsView {
  fields: Record<SettingKey, SettingFieldView>;
  /** Per-provider LLM channels; `source` covers the list as a whole. */
  llmProviders: { source: "override" | "env"; items: LlmProviderView[] };
  updatedAt?: string;
}

export interface LlmProviderInput {
  name: string;
  baseUrl: string;
  /** Masked keeps the currently effective key for this provider name. */
  apiKey: string;
  keepModelPrefix?: boolean;
}

export type SettingsUpdate = Partial<Record<SettingKey, string>> & {
  /** Full replacement list; empty array removes the override (env fallback). */
  llmProviders?: LlmProviderInput[];
};

function toProviderViews(
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
  settings: AppSettings | null,
): SettingsView["llmProviders"] {
  const stored = settings?.llmProviders;
  if (stored !== undefined) {
    return {
      source: "override",
      items: stored.map((provider) => ({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: cipher.mask(provider.apiKey),
        keepModelPrefix: provider.keepModelPrefix ?? false,
      })),
    };
  }
  return {
    source: "env",
    items: parseProviderConfigs(env).map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: cipher.mask(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix,
    })),
  };
}

function toView(
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
  specs: FieldSpec[],
  settings: AppSettings | null,
): SettingsView {
  const fields = {} as Record<SettingKey, SettingFieldView>;
  for (const spec of specs) {
    const stored = settings?.[spec.key];
    if (stored !== undefined) {
      fields[spec.key] = {
        value: spec.secret ? cipher.mask(stored) : stored,
        source: "override",
        secret: spec.secret,
      };
      continue;
    }
    const envValue = spec.env();
    if (envValue !== undefined) {
      fields[spec.key] = {
        value: spec.secret ? cipher.mask(envValue) : envValue,
        source: "env",
        secret: spec.secret,
      };
      continue;
    }
    fields[spec.key] = {
      value: spec.defaultValue ?? "",
      source: spec.defaultValue !== undefined ? "default" : "unset",
      secret: spec.secret,
    };
  }
  return {
    fields,
    llmProviders: toProviderViews(cipher, env, parseProviderConfigs, settings),
    updatedAt: settings?.updatedAt,
  };
}

/**
 * Resolve one submitted provider row to its stored form. A masked apiKey keeps
 * the currently effective key for that provider name — from the existing
 * override first, else from the env-derived provider set.
 */
function toProviderSetting(
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
  input: LlmProviderInput,
  stored: LlmProviderSetting[] | undefined,
): LlmProviderSetting {
  const name = input.name.trim().toLowerCase();
  const baseUrl = input.baseUrl.trim();
  if (!name || !baseUrl) {
    throw new ValidationError("Each LLM provider needs a name and a base URL");
  }
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(name)) {
    throw new ValidationError(
      `Unsupported LLM provider "${name}" — supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
  const apiKey = input.apiKey.trim();
  let storedKey: string;
  if (!cipher.isMasked(apiKey)) {
    if (!apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key`);
    }
    storedKey = cipher.encrypt(apiKey);
  } else {
    const existingStoredKey = stored?.find((provider) => provider.name === name)?.apiKey;
    const envKey = parseProviderConfigs(env).find((provider) => provider.name === name)?.apiKey;
    if (existingStoredKey !== undefined) {
      return {
        name,
        baseUrl,
        apiKey: existingStoredKey,
        ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
      };
    }
    if (envKey === undefined) {
      throw new ValidationError(`LLM provider "${name}" needs an API key (no stored value to keep)`);
    }
    storedKey = cipher.encrypt(envKey);
  }
  return {
    name,
    baseUrl,
    apiKey: storedKey,
    ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
  };
}

export interface SettingsUseCases {
  getView(): Promise<SettingsView>;
  /** Merge semantics: masked secret keeps the override; empty string removes it (env fallback). */
  update(patch: SettingsUpdate, userEmail: string): Promise<SettingsView>;
}

export function createSettingsUseCases(
  repo: SettingsRepository,
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
): SettingsUseCases {
  // `env` is fixed for the process, so the specs and their fallback closures are
  // built once here rather than rebuilt on every settings read and write.
  const specs = fieldSpecs(env);
  return {
    async getView() {
      return toView(cipher, env, parseProviderConfigs, specs, await repo.get());
    },

    async update(patch, userEmail) {
      const stored = await repo.get();
      const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
      for (const spec of specs) {
        const raw = patch[spec.key];
        if (raw === undefined) {
          continue;
        }
        const value = raw.trim();
        if (value === "") {
          delete next[spec.key];
        } else if (spec.secret) {
          if (!cipher.isMasked(value)) {
            next[spec.key] = cipher.encrypt(value);
          }
        } else {
          next[spec.key] = value;
        }
      }

      if (patch.llmProviders !== undefined) {
        if (patch.llmProviders.length === 0) {
          delete next.llmProviders;
        } else {
          const providers = patch.llmProviders.map((input) =>
            toProviderSetting(cipher, env, parseProviderConfigs, input, stored?.llmProviders),
          );
          const names = new Set(providers.map((provider) => provider.name));
          if (names.size !== providers.length) {
            throw new ValidationError("LLM provider names must be unique");
          }
          next.llmProviders = providers;
        }
      }

      /*
       * A stored access-control list that parses to nothing is never what the
       * operator meant, and it is *not* the same as clearing the field: an
       * absent override falls back to the env var, which `assertAccessControlConfig`
       * requires on alpha/prod. A present-but-empty one falls back to nothing.
       *
       * The result would be silent and contradictory. An empty admin list makes
       * `isAdminEmail` true for everyone — every signed-in user could then mutate
       * the shared registries and re-edit this very page — while making
       * `isConfiguredAdmin` false for everyone, revoking the project override at
       * the same moment. An empty allowed-domains list lets any Google account
       * sign in. The boot guard cannot catch either, because it reads the env var
       * and never runs again. Rejecting the value here is what keeps "effectively
       * empty on a deployed stage" unreachable.
       */
      for (const key of ["adminEmails", "allowedEmailDomains"] as const) {
        const stored = next[key];
        if (stored !== undefined && parseList(stored).length === 0) {
          throw new ValidationError(
            `${key} must name at least one entry — clear the field entirely to fall back to the environment variable`,
          );
        }
      }

      const effectiveAdmins = parseList(next.adminEmails ?? env.ADMIN_EMAILS ?? "");
      if (effectiveAdmins.length > 0 && !effectiveAdmins.includes(userEmail.toLowerCase())) {
        throw new ValidationError(
          `adminEmails must include your own email (${userEmail}) — otherwise you would lock yourself out`,
        );
      }

      next.updatedAt = new Date().toISOString();
      await repo.put(next);
      return toView(cipher, env, parseProviderConfigs, specs, next);
    },
  };
}
