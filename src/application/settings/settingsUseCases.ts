import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  AppSettings,
  ChannelAuth,
  LlmProviderSetting,
  ProviderChannelConfig,
} from "@/domain/settings/types";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { DEFAULT_RERANKER_MIN_SCORE } from "@/domain/catalog/types";
import { DEFAULT_MIN_SCORE } from "@/domain/catalog/types";
import { DEFAULT_RUN_SLOTS_PER_ACTOR, MAX_RUN_SLOTS } from "@/domain/execution/runSlot";
import { DEFAULT_LOADING_INDICATOR } from "@/shared/slackLoadingIndicator";
import { providerBaseUrl, providerKind } from "@/domain/llm/providerModels";
import type { SupportedProvider } from "@/domain/llm/models";
import { parseList } from "@/shared/parseList";
import { optionalEnv } from "@/shared/env";
import { DEFAULT_SERVICE_LOGO, DEFAULT_SERVICE_NAME, resolveBranding } from "@/shared/branding";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  llmProviderApiKeyContext,
  settingsSecretContext,
} from "@/domain/security/secretContext";

/** Reads `LLM_PROVIDER_*` env vars into channel configs. Injected. */
export type ParseProviderConfigs = (env: NodeJS.ProcessEnv) => ProviderChannelConfig[];

export type SettingKey = Exclude<
  keyof AppSettings,
  "updatedAt" | "llmProviders" | "workspaceModels" | "registeredModels" | "defaultModel" | "decisionModel"
>;

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
 * view partly uncontrollable.
 *
 * The reads go through `optionalEnv` for the same reason `config` does, and
 * *particularly* here: an override is stored trimmed already (see `update`), so
 * without it the page would answer the blank question one way for an override
 * and the other way for the environment, and report a variable holding a space
 * as the effective value.
 */
const fieldSpecs = (env: NodeJS.ProcessEnv): FieldSpec[] => [
  { key: "serviceName", secret: false, env: () => optionalEnv(env.SERVICE_NAME), defaultValue: DEFAULT_SERVICE_NAME },
  { key: "serviceLogo", secret: false, env: () => optionalEnv(env.SERVICE_LOGO), defaultValue: DEFAULT_SERVICE_LOGO },
  { key: "catalogMinScore", secret: false, env: () => optionalEnv(env.CATALOG_MIN_SCORE), defaultValue: String(DEFAULT_MIN_SCORE) },
  { key: "maxConcurrentRunsPerActor", secret: false, env: () => optionalEnv(env.MAX_CONCURRENT_RUNS_PER_ACTOR), defaultValue: String(DEFAULT_RUN_SLOTS_PER_ACTOR) },
  { key: "s3PublicBaseUrl", secret: false, env: () => optionalEnv(env.S3_PUBLIC_BASE_URL) },
  { key: "slackLoadingIndicator", secret: false, env: () => optionalEnv(env.SLACK_LOADING_INDICATOR), defaultValue: DEFAULT_LOADING_INDICATOR },
  { key: "adminEmails", secret: false, env: () => optionalEnv(env.ADMIN_EMAILS) },
  {
    key: "allowedEmailDomains",
    secret: false,
    env: () => optionalEnv(env.ALLOWED_EMAIL_DOMAINS),
  },
  { key: "embeddingModel", secret: false, env: () => undefined },
  { key: "rerankerModel", secret: false, env: () => undefined },
  {
    key: "rerankerMinScore",
    secret: false,
    env: () => optionalEnv(env.RERANKER_MIN_SCORE),
    defaultValue: String(DEFAULT_RERANKER_MIN_SCORE),
  },
  { key: "pluginsRepo", secret: false, env: () => optionalEnv(env.PLUGINS_REPO) },
  {
    key: "pluginsRepoBranch",
    secret: false,
    env: () => optionalEnv(env.PLUGINS_REPO_BRANCH),
    defaultValue: "main",
  },
  { key: "githubToken", secret: true, env: () => optionalEnv(env.GITHUB_TOKEN) },
  {
    key: "publicBaseUrl",
    secret: false,
    // Same precedence as `config.publicBaseUrl`: the explicit setting wins,
    // then the auth URL, which is set on every deployment that has OAuth.
    env: () => optionalEnv(env.PUBLIC_BASE_URL) ?? optionalEnv(env.BETTER_AUTH_URL),
  },
  {
    key: "artifactAccessMode",
    secret: false,
    env: () => optionalEnv(env.ARTIFACT_ACCESS_MODE),
    defaultValue: "authenticated",
  },
  {
    key: "unknownModelPolicy",
    secret: false,
    env: () => optionalEnv(env.UNKNOWN_MODEL_POLICY),
    defaultValue: "allow",
  },
];

export interface SettingFieldView {
  /** Masked for secrets (length-preserving; four visible characters at each end above eight characters) —
   * never the full plaintext or the ciphertext. */
  value: string;
  source: "override" | "env" | "default" | "unset";
  secret: boolean;
}

export interface LlmProviderView {
  name: string;
  kind: SupportedProvider;
  baseUrl: string;
  /** Masked (length-preserving; four visible characters at each end above eight characters). */
  apiKey: string;
  keepModelPrefix: boolean;
  auth: ChannelAuth;
}

export interface SettingsView {
  fields: Record<SettingKey, SettingFieldView>;
  /** Brand folders with every required asset present in this deployment. */
  serviceLogos: string[];
  /** Per-provider LLM channels; `source` covers the list as a whole. */
  llmProviders: { source: "override" | "env"; items: LlmProviderView[] };
  updatedAt?: string;
}

export interface LlmProviderInput {
  name: string;
  kind?: SupportedProvider;
  baseUrl: string;
  /** Masked keeps the currently effective key for this provider name. */
  apiKey: string;
  keepModelPrefix?: boolean;
  /** Absent means `bearer`; `sigv4` rows carry no key at all. */
  auth?: ChannelAuth;
}

export type SettingsUpdate = Partial<Record<SettingKey, string>> & {
  /** Full replacement list; empty array disables every provider. */
  llmProviders?: LlmProviderInput[];
};

/**
 * Which settings a write actually moved — the audit row's detail. Names only:
 * some fields carry credentials and another is the admin list, so
 * recording what changed must never record what it changed to.
 *
 * Compare stored values rather than submitted field names: an unchanged mask
 * or a value equal to the environment does not constitute a settings change.
 *
 * The comparison is on the *stored* form, so a masked secret resubmitted
 * unchanged compares equal and a cleared override compares against `undefined`.
 */
function changedKeys(specs: FieldSpec[], stored: AppSettings | null, next: AppSettings): string[] {
  const changed: string[] = specs
    .filter((spec) => stored?.[spec.key] !== next[spec.key])
    .map((spec) => spec.key);
  // Structural rather than by reference: the list is rebuilt on every write that
  // carries one, so identity would report a change for a resubmitted list.
  if (JSON.stringify(stored?.llmProviders) !== JSON.stringify(next.llmProviders)) {
    changed.push("llmProviders");
  }
  return changed;
}

function fieldSecretContext(
  key: SettingKey,
): string {
  switch (key) {
    case "githubToken":
      return settingsSecretContext("github-token");
    default:
      throw new Error(`No encryption context is defined for secret setting "${key}"`);
  }
}


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
        kind: providerKind(provider),
        baseUrl: provider.baseUrl,
        apiKey: cipher.mask(
          provider.apiKey,
          llmProviderApiKeyContext(provider.name, provider.baseUrl),
        ),
        keepModelPrefix: provider.keepModelPrefix ?? false,
        auth: provider.auth ?? "bearer",
      })),
    };
  }
  return {
    source: "env",
    items: parseProviderConfigs(env).map((provider) => ({
      name: provider.name,
      kind: providerKind(provider),
      baseUrl: provider.baseUrl,
      apiKey: cipher.mask(provider.apiKey),
      keepModelPrefix: provider.keepModelPrefix,
      auth: provider.auth,
    })),
  };
}

function toView(
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
  specs: FieldSpec[],
  settings: AppSettings | null,
  serviceLogos: readonly string[],
): SettingsView {
  const fields = {} as Record<SettingKey, SettingFieldView>;
  for (const spec of specs) {
    const stored = settings?.[spec.key];
    if (stored !== undefined) {
      fields[spec.key] = {
        value: spec.secret
          ? cipher.mask(stored, fieldSecretContext(spec.key))
          : stored,
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
    serviceLogos: [...serviceLogos],
    llmProviders: toProviderViews(cipher, env, parseProviderConfigs, settings),
    updatedAt: settings?.updatedAt,
  };
}

/** Resolve one submitted provider row without moving a credential to a new target. */
function toProviderSetting(
  cipher: SecretCipher,
  env: NodeJS.ProcessEnv,
  parseProviderConfigs: ParseProviderConfigs,
  input: LlmProviderInput,
  stored: LlmProviderSetting[] | undefined,
): LlmProviderSetting {
  const name = input.name.trim().toLowerCase();
  let baseUrl: string;
  try { baseUrl = providerBaseUrl(input.baseUrl.trim()); }
  catch { throw new ValidationError("Provider URL must be HTTP(S) without credentials, query parameters or fragments"); }
  if (!name || !baseUrl) {
    throw new ValidationError("Each LLM provider needs a name and a base URL");
  }
  const kind = providerKind({ name, kind: input.kind });
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new ValidationError("Invalid provider name");
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `Unsupported LLM provider "${name}" — supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
  // A signed channel has no key, so every key rule below is skipped rather than
  // satisfied with a placeholder — a stored blank is what "this row carries no
  // credential" means, and the mask/keep dance has nothing to keep.
  if (input.auth === "sigv4") {
    return {
      name,
      kind,
      baseUrl,
      apiKey: "",
      auth: "sigv4",
      ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
    };
  }
  const apiKey = input.apiKey.trim();
  let storedKey: string;
  const existing = stored?.find((provider) => provider.name === name);
  const fromEnv = parseProviderConfigs(env).find((provider) => provider.name === name);
  const previous = existing ?? fromEnv;
  if (!apiKey && kind === "selfhosted" && !previous?.apiKey) {
    storedKey = "";
  } else if (apiKey && !cipher.isMasked(apiKey)) {
    storedKey = cipher.encrypt(apiKey, llmProviderApiKeyContext(name, baseUrl));
  } else {
    if (!previous?.apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key (no stored value to keep)`);
    }
    if ((previous.auth ?? "bearer") !== "bearer" || providerBaseUrl(previous.baseUrl) !== baseUrl || providerKind(previous) !== kind) {
      throw new ValidationError(
        `Changing LLM provider "${name}" endpoint or auth requires a new API key`,
      );
    }
    storedKey = existing
      ? existing.baseUrl === baseUrl ? existing.apiKey : cipher.encrypt(
          cipher.decrypt(existing.apiKey, llmProviderApiKeyContext(name, existing.baseUrl)),
          llmProviderApiKeyContext(name, baseUrl),
        )
      : cipher.encrypt(previous.apiKey, llmProviderApiKeyContext(name, baseUrl));
  }
  return {
    name,
    kind,
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
  serviceLogos: readonly string[],
): SettingsUseCases {
  // `env` is fixed for the process, so the specs and their fallback closures are
  // built once here rather than rebuilt on every settings read and write.
  const specs = fieldSpecs(env);
  return {
    async getView() {
      return toView(cipher, env, parseProviderConfigs, specs, await repo.get(), serviceLogos);
    },

    /**
     * Merge semantics, plus one rule about what an override *is*.
     *
     * A submitted value equal to the environment is not pinned as an override.
     * Later deployment changes remain effective until an operator stores a
     * different value explicitly.
     */
    async update(patch, userEmail) {
      let changed: string[] = [];
      const mutate = (stored: AppSettings | null): AppSettings => {
        const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
        for (const spec of specs) {
          const raw = patch[spec.key];
          if (raw === undefined) {
            continue;
          }
          const value = raw.trim();
          if (value && (spec.key === "embeddingModel" || spec.key === "rerankerModel")) {
            const type = spec.key === "embeddingModel" ? "embedding" : "rerank";
            if (!stored?.registeredModels?.some(model => model.id === value && model.type === type)) {
              throw new ValidationError(`The selected ${type} model is no longer registered`);
            }
          }
          if (spec.key === "rerankerMinScore" && value !== "") {
            const score = Number(value);
            if (!Number.isFinite(score) || score < 0 || score > 1) {
              throw new ValidationError("Reranker minimum score must be between 0 and 1");
            }
          }
          if (spec.key === "catalogMinScore" && value !== "") {
            const score = Number(value);
            if (!Number.isFinite(score) || score < 0 || score > 1) {
              throw new ValidationError("Catalog minimum score must be between 0 and 1");
            }
          }
          if (spec.key === "maxConcurrentRunsPerActor" && value !== "") {
            const limit = Number(value);
            if (!Number.isInteger(limit) || limit < 0 || limit > MAX_RUN_SLOTS) {
              throw new ValidationError(`Concurrent runs per actor must be between 0 and ${MAX_RUN_SLOTS}`);
            }
          }
          if (spec.key === "s3PublicBaseUrl" && value !== "") {
            try {
              const url = new URL(value);
              if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
            } catch {
              throw new ValidationError("Public object URL must be HTTP(S) without credentials, query parameters or fragments");
            }
          }
          if (spec.key === "slackLoadingIndicator" && value !== "" && (value.length > 80 || /[\u0000-\u001f\u007f]/.test(value))) {
            throw new ValidationError("Slack loading indicator must be one line of at most 80 characters");
          }
          if (spec.key === "artifactAccessMode" && value !== "") {
            if (value !== "authenticated" && value !== "public" && value !== "proxied") {
              throw new ValidationError(
                "Artifact access mode must be authenticated, public or proxied",
              );
            }
            if (value === spec.env()) {
              delete next.artifactAccessMode;
            } else {
              next.artifactAccessMode = value;
            }
            continue;
          }
          if (value === "") {
            delete next[spec.key];
          } else if (spec.secret) {
            if (cipher.isMasked(value)) {
              // A mask confirms what is stored; it says nothing to compare.
            } else if (value === spec.env()) {
              delete next[spec.key];
            } else {
              next[spec.key] = cipher.encrypt(
                value,
                fieldSecretContext(spec.key),
              );
            }
          } else if (
            value === spec.env() ||
            (["rerankerMinScore", "catalogMinScore", "maxConcurrentRunsPerActor"].includes(spec.key) &&
              spec.env() === undefined &&
              value === spec.defaultValue)
          ) {
            delete next[spec.key];
          } else {
            next[spec.key] = value;
          }
        }
        if (patch.llmProviders !== undefined) {
          const providers = patch.llmProviders.map((input) =>
            toProviderSetting(cipher, env, parseProviderConfigs, input, stored?.llmProviders),
          );
          const names = new Set(providers.map((provider) => provider.name));
          if (names.size !== providers.length) {
            throw new ValidationError("LLM provider names must be unique");
          }
          const orphaned = (stored?.registeredModels ?? []).filter((model) => !names.has(model.provider));
          if (orphaned.length) throw new ValidationError("Delete this provider's registered models before removing the provider");
          next.llmProviders = providers;
        }

        /*
         * A stored access-control list that parses to nothing is never what the
         * operator meant, and it is *not* the same as clearing the field: an absent
         * override falls back to the env var, a present-but-empty one falls back to
         * nothing.
         *
         * What it would fall back *to* is fail-open and silent. An empty admin list
         * makes `isAdminEmail` true for everyone — every signed-in user could then
         * mutate the shared registries and re-edit this very page — while making
         * `isConfiguredAdmin` false for everyone, revoking the agent override at
         * the same moment; `assertAccessControlConfig` cannot catch it, because it
         * reads the env var and never runs again. An empty allowed-domains list lets
         * any Google account sign in, which a deployment chooses by leaving the env
         * var unset, not by saving a value that reads as a list and is not one.
         */
        for (const key of ["adminEmails", "allowedEmailDomains"] as const) {
          const stored = next[key];
          if (stored !== undefined && parseList(stored).length === 0) {
            throw new ValidationError(
              `${key} must name at least one entry — clear the field entirely to fall back to the environment variable`,
            );
          }
        }

        try {
          resolveBranding(next.serviceName ?? optionalEnv(env.SERVICE_NAME), next.serviceLogo ?? optionalEnv(env.SERVICE_LOGO));
        } catch {
          throw new ValidationError("Service name must be a single line of at most 80 characters and logo must name a brand folder");
        }
        const effectiveLogo = next.serviceLogo ?? optionalEnv(env.SERVICE_LOGO) ?? DEFAULT_SERVICE_LOGO;
        if (!serviceLogos.includes(effectiveLogo)) {
          throw new ValidationError("Service logo must have all required brand assets in this deployment");
        }

        const effectiveAdmins = parseList(next.adminEmails ?? env.ADMIN_EMAILS ?? "");
        if (effectiveAdmins.length > 0 && !effectiveAdmins.includes(userEmail.toLowerCase())) {
          throw new ValidationError(
            `adminEmails must include your own email (${userEmail}) — otherwise you would lock yourself out`,
          );
        }

        // Before `updatedAt` moves, which every write bumps and no reader of this
        // row cares about.
        changed = changedKeys(specs, stored, next);
        next.updatedAt = new Date().toISOString();
        return next;
      };
      const { after: next } = await repo.update(mutate);
      // The row keeps only *which* keys were written, never their values: the
      // admin list is one of them and the LLM credential is another. Without
      // this the settings item held `updatedAt` and nothing about who moved it.
      await recordAudit({
        actorEmail: userEmail,
        action: "settings.update",
        target: auditTarget("settings", "app"),
        detail: changed.join(", ") || "no fields changed",
      });
      return toView(cipher, env, parseProviderConfigs, specs, next, serviceLogos);
    },
  };
}
