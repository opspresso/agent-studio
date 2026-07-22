import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, LlmProviderSetting } from "@/domain/settings/types";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";
import { config } from "@/lib/config";
import { encryptSecret, isMasked, maskSecret } from "@/lib/secret-encryption";

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
 * Env-overridable settings managed on the /settings page. `config.llmBaseUrl`
 * and `config.llmApiKey` getters throw when unset, so those read process.env
 * directly.
 */
const FIELD_SPECS: FieldSpec[] = [
  { key: "adminEmails", secret: false, env: () => process.env.ADMIN_EMAILS || undefined },
  {
    key: "allowedEmailDomains",
    secret: false,
    env: () => process.env.ALLOWED_EMAIL_DOMAINS || undefined,
  },
  { key: "llmBaseUrl", secret: false, env: () => process.env.LLM_BASE_URL || undefined },
  { key: "llmApiKey", secret: true, env: () => process.env.LLM_API_KEY || undefined },
  { key: "slackDefaultProject", secret: false, env: () => config.slackDefaultProject },
  { key: "slackBotToken", secret: true, env: () => config.slackBotToken },
  { key: "slackSigningSecret", secret: true, env: () => config.slackSigningSecret },
  { key: "skillsRepo", secret: false, env: () => config.skillsRepo },
  {
    key: "skillsRepoBranch",
    secret: false,
    env: () => process.env.SKILLS_REPO_BRANCH || undefined,
    defaultValue: "main",
  },
  { key: "githubToken", secret: true, env: () => config.githubToken },
  { key: "a2aApiKey", secret: true, env: () => config.a2aApiKey },
  { key: "publicBaseUrl", secret: false, env: () => config.publicBaseUrl },
];

export interface SettingFieldView {
  /** Masked (length-preserving asterisks) for secrets — never plaintext or ciphertext. */
  value: string;
  source: "override" | "env" | "default" | "unset";
  secret: boolean;
}

export interface LlmProviderView {
  name: string;
  baseUrl: string;
  /** Masked (length-preserving asterisks). */
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

function toProviderViews(settings: AppSettings | null): SettingsView["llmProviders"] {
  const stored = settings?.llmProviders;
  if (stored !== undefined) {
    return {
      source: "override",
      items: stored.map((provider) => ({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: maskSecret(provider.apiKey),
        keepModelPrefix: provider.keepModelPrefix ?? false,
      })),
    };
  }
  return {
    source: "env",
    items: parseProviderConfigs(process.env).map((provider) => ({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: maskSecret(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix,
    })),
  };
}

function toView(settings: AppSettings | null): SettingsView {
  const fields = {} as Record<SettingKey, SettingFieldView>;
  for (const spec of FIELD_SPECS) {
    const stored = settings?.[spec.key];
    if (stored !== undefined) {
      fields[spec.key] = {
        value: spec.secret ? maskSecret(stored) : stored,
        source: "override",
        secret: spec.secret,
      };
      continue;
    }
    const envValue = spec.env();
    if (envValue !== undefined) {
      fields[spec.key] = {
        value: spec.secret ? maskSecret(envValue) : envValue,
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
  return { fields, llmProviders: toProviderViews(settings), updatedAt: settings?.updatedAt };
}

/**
 * Resolve one submitted provider row to its stored form. A masked apiKey keeps
 * the currently effective key for that provider name — from the existing
 * override first, else from the env-derived provider set.
 */
function toProviderSetting(
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
  if (!isMasked(apiKey)) {
    if (!apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key`);
    }
    storedKey = encryptSecret(apiKey);
  } else {
    const existing =
      stored?.find((provider) => provider.name === name)?.apiKey ??
      parseProviderConfigs(process.env).find((provider) => provider.name === name)?.apiKey;
    if (existing === undefined) {
      throw new ValidationError(`LLM provider "${name}" needs an API key (no stored value to keep)`);
    }
    storedKey = encryptSecret(existing);
  }
  return {
    name,
    baseUrl,
    apiKey: storedKey,
    ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
  };
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export interface SettingsUseCases {
  getView(): Promise<SettingsView>;
  /** Merge semantics: masked secret keeps the override; empty string removes it (env fallback). */
  update(patch: SettingsUpdate, userEmail: string): Promise<SettingsView>;
}

export function createSettingsUseCases(repo: SettingsRepository): SettingsUseCases {
  return {
    async getView() {
      return toView(await repo.get());
    },

    async update(patch, userEmail) {
      const stored = await repo.get();
      const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
      for (const spec of FIELD_SPECS) {
        const raw = patch[spec.key];
        if (raw === undefined) {
          continue;
        }
        const value = raw.trim();
        if (value === "") {
          delete next[spec.key];
        } else if (spec.secret) {
          if (!isMasked(value)) {
            next[spec.key] = encryptSecret(value);
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
            toProviderSetting(input, stored?.llmProviders),
          );
          const names = new Set(providers.map((provider) => provider.name));
          if (names.size !== providers.length) {
            throw new ValidationError("LLM provider names must be unique");
          }
          next.llmProviders = providers;
        }
      }

      const effectiveAdmins =
        next.adminEmails !== undefined ? parseList(next.adminEmails) : config.adminEmails;
      if (effectiveAdmins.length > 0 && !effectiveAdmins.includes(userEmail.toLowerCase())) {
        throw new ValidationError(
          `adminEmails must include your own email (${userEmail}) — otherwise you would lock yourself out`,
        );
      }

      next.updatedAt = new Date().toISOString();
      await repo.put(next);
      return toView(next);
    },
  };
}
