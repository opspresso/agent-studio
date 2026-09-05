import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type {
  AppSettings,
  ChannelAuth,
  LlmProviderSetting,
  ProviderChannelConfig,
} from "@/domain/settings/types";
import {
  getModelConfig,
  loadSelfHostedModels,
  MAX_HIDDEN_MODELS,
  modelType,
  offeredModels,
  selfHostedModelRejectReason,
  SUPPORTED_PROVIDERS,
} from "@/domain/llm/models";
import {
  selfHostedModelFromInput,
  type SelfHostedModelInput,
} from "@/domain/llm/selfHostedModels";
import { DEFAULT_RERANKER_MIN_SCORE } from "@/domain/catalog/types";
import { parseList } from "@/shared/parseList";
import { optionalEnv } from "@/shared/env";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  llmApiKeyContext,
  llmProviderApiKeyContext,
  settingsSecretContext,
} from "@/domain/security/secretContext";

/** Reads `LLM_PROVIDER_*` env vars into channel configs. Injected. */
export type ParseProviderConfigs = (env: NodeJS.ProcessEnv) => ProviderChannelConfig[];

export type SettingKey = Exclude<
  keyof AppSettings,
  "updatedAt" | "llmProviders" | "hiddenModels" | "selfHostedModels"
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
 * view partly uncontrollable — and `config.llmBaseUrl`/`llmApiKey` additionally
 * throw when unset, which a settings *view* must not do.
 *
 * The reads go through `optionalEnv` for the same reason `config` does, and
 * *particularly* here: an override is stored trimmed already (see `update`), so
 * without it the page would answer the blank question one way for an override
 * and the other way for the environment, and report a variable holding a space
 * as the effective value.
 */
const fieldSpecs = (env: NodeJS.ProcessEnv): FieldSpec[] => [
  { key: "adminEmails", secret: false, env: () => optionalEnv(env.ADMIN_EMAILS) },
  {
    key: "allowedEmailDomains",
    secret: false,
    env: () => optionalEnv(env.ALLOWED_EMAIL_DOMAINS),
  },
  { key: "llmBaseUrl", secret: false, env: () => optionalEnv(env.LLM_BASE_URL) },
  { key: "llmApiKey", secret: true, env: () => optionalEnv(env.LLM_API_KEY) },
  { key: "embeddingModel", secret: false, env: () => optionalEnv(env.EMBEDDING_MODEL) },
  { key: "rerankerModel", secret: false, env: () => optionalEnv(env.RERANKER_MODEL) },
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
  { key: "a2aApiKey", secret: true, env: () => optionalEnv(env.A2A_API_KEY) },
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
  auth: ChannelAuth;
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
  /** Absent means `bearer`; `sigv4` rows carry no key at all. */
  auth?: ChannelAuth;
}

export type { SelfHostedModelInput };

export type SettingsUpdate = Partial<Record<SettingKey, string>> & {
  /** Full replacement list; empty array removes the override (env fallback). */
  llmProviders?: LlmProviderInput[];
  /** Full replacement list; empty array removes the override (no models hidden). */
  hiddenModels?: string[];
  /** Full replacement list; empty array removes every declaration. */
  selfHostedModels?: SelfHostedModelInput[];
};

/**
 * Which settings a write actually moved — the audit row's detail. Names only:
 * two of these fields *are* credentials, and a third is the admin list, so
 * recording what changed must never record what it changed to.
 *
 * Diffed against what was stored rather than read off the patch's key set,
 * because the settings page submits every field on every save. Keys-carried
 * would make the detail a constant listing all ten, which says only "the form
 * was saved" — the one thing the row already says by existing. "Who changed the
 * admin list last quarter" is the question this trail exists for, and a constant
 * cannot answer it.
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
  if (JSON.stringify(stored?.hiddenModels) !== JSON.stringify(next.hiddenModels)) {
    changed.push("hiddenModels");
  }
  if (JSON.stringify(stored?.selfHostedModels) !== JSON.stringify(next.selfHostedModels)) {
    changed.push("selfHostedModels");
  }
  return changed;
}

function fieldSecretContext(
  key: SettingKey,
  settings: AppSettings | null,
  env: NodeJS.ProcessEnv,
): string {
  switch (key) {
    case "llmApiKey":
      return llmApiKeyContext(settings?.llmBaseUrl ?? optionalEnv(env.LLM_BASE_URL) ?? "");
    case "githubToken":
      return settingsSecretContext("github-token");
    case "a2aApiKey":
      return settingsSecretContext("a2a-api-key");
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
): SettingsView {
  const fields = {} as Record<SettingKey, SettingFieldView>;
  for (const spec of specs) {
    const stored = settings?.[spec.key];
    if (stored !== undefined) {
      fields[spec.key] = {
        value: spec.secret
          ? cipher.mask(stored, fieldSecretContext(spec.key, settings, env))
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
  const baseUrl = input.baseUrl.trim();
  if (!name || !baseUrl) {
    throw new ValidationError("Each LLM provider needs a name and a base URL");
  }
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(name)) {
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
      baseUrl,
      apiKey: "",
      auth: "sigv4",
      ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
    };
  }
  const apiKey = input.apiKey.trim();
  let storedKey: string;
  if (!cipher.isMasked(apiKey)) {
    if (!apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key`);
    }
    storedKey = cipher.encrypt(apiKey, llmProviderApiKeyContext(name, baseUrl));
  } else {
    const existing = stored?.find((provider) => provider.name === name);
    const fromEnv = parseProviderConfigs(env).find((provider) => provider.name === name);
    const previous = existing ?? fromEnv;
    if (!previous?.apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key (no stored value to keep)`);
    }
    if ((previous.auth ?? "bearer") !== "bearer" || previous.baseUrl !== baseUrl) {
      throw new ValidationError(
        `Changing LLM provider "${name}" endpoint or auth requires a new API key`,
      );
    }
    storedKey = existing
      ? existing.apiKey
      : cipher.encrypt(previous.apiKey, llmProviderApiKeyContext(name, baseUrl));
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

    /**
     * Merge semantics, plus one rule about what an override *is*.
     *
     * A submitted value equal to the environment's is not stored. The page
     * posts every field on every save, so without this the first save turned
     * all ten into overrides — each one a row that reads `override` while
     * naming the value it was already falling back to, and, worse, one that
     * keeps naming it after the deployment's env var moves on. "Same as env"
     * has no way to say "and pin it there", which is the only thing the stored
     * copy would add.
     */
    async update(patch, userEmail) {
      let changed: string[] = [];
      const mutate = (stored: AppSettings | null): AppSettings => {
        const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
        const envBaseUrl = optionalEnv(env.LLM_BASE_URL);
        const envApiKey = optionalEnv(env.LLM_API_KEY);
        const submittedBaseUrl = patch.llmBaseUrl?.trim();
        const currentBaseUrl = stored?.llmBaseUrl ?? envBaseUrl;
        const nextBaseUrl =
          submittedBaseUrl === undefined
            ? currentBaseUrl
            : submittedBaseUrl === "" || submittedBaseUrl === envBaseUrl
              ? envBaseUrl
              : submittedBaseUrl;
        const llmTargetChanged = nextBaseUrl !== currentBaseUrl;
        const submittedApiKey = patch.llmApiKey?.trim();
        const revertsLlmPairToEnv =
          nextBaseUrl === envBaseUrl &&
          (submittedApiKey === "" || submittedApiKey === envApiKey);
        if (
          llmTargetChanged &&
          !revertsLlmPairToEnv &&
          (!submittedApiKey || cipher.isMasked(submittedApiKey))
        ) {
          throw new ValidationError("Changing LLM_BASE_URL requires a new LLM_API_KEY");
        }
        for (const spec of specs) {
          const raw = patch[spec.key];
          if (raw === undefined) {
            continue;
          }
          const value = raw.trim();
          if (spec.key === "rerankerMinScore" && value !== "") {
            const score = Number(value);
            if (!Number.isFinite(score) || score < 0 || score > 1) {
              throw new ValidationError("Reranker minimum score must be between 0 and 1");
            }
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
            } else if (
              value === spec.env() &&
              !(
                spec.key === "llmApiKey" &&
                llmTargetChanged &&
                !revertsLlmPairToEnv
              )
            ) {
              delete next[spec.key];
            } else {
              next[spec.key] = cipher.encrypt(
                value,
                fieldSecretContext(spec.key, next, env),
              );
            }
          } else if (
            value === spec.env() ||
            (spec.key === "rerankerMinScore" &&
              spec.env() === undefined &&
              value === spec.defaultValue)
          ) {
            delete next[spec.key];
          } else {
            next[spec.key] = value;
          }
        }
        if (next.llmBaseUrl !== undefined && next.llmApiKey === undefined) {
          throw new ValidationError("A stored LLM_BASE_URL requires a stored LLM_API_KEY");
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

        if (patch.selfHostedModels !== undefined) {
          if (patch.selfHostedModels.length === 0) {
            delete next.selfHostedModels;
          } else {
            const declarations = patch.selfHostedModels.map(selfHostedModelFromInput);
            // The same validation the install runs, surfaced as the save's
            // error instead of a warning after it — a declaration that cannot
            // install must fail the form, not silently vanish from the picker.
            const problems = declarations
              .map((entry) => {
                const reason = selfHostedModelRejectReason(entry);
                return reason === null ? null : `${entry.id} — ${reason}`;
              })
              .filter((problem): problem is string => problem !== null);
            if (problems.length > 0) {
              throw new ValidationError(`Invalid self-hosted model(s): ${problems.join("; ")}`);
            }
            const ids = new Set(declarations.map((entry) => entry.id));
            if (ids.size !== declarations.length) {
              throw new ValidationError("Self-hosted model families must be unique");
            }
            next.selfHostedModels = declarations;
          }
          const declarationsById = new Map(
            (next.selfHostedModels ?? []).map((entry) => [entry.id, entry]),
          );
          for (const [selectionType, id] of [
            ["embedding", next.embeddingModel ?? optionalEnv(env.EMBEDDING_MODEL)],
            ["rerank", next.rerankerModel ?? optionalEnv(env.RERANKER_MODEL)],
          ] as const) {
            if (id?.startsWith("selfhosted/") !== true) continue;
            const declaration = declarationsById.get(id);
            if (!declaration) {
              throw new ValidationError(`Selected self-hosted models must remain declared: ${id}`);
            }
            if (modelType(declaration) !== selectionType) {
              throw new ValidationError(
                `Selected self-hosted model must remain ${selectionType}: ${id}`,
              );
            }
          }
          const declaredIds = new Set(declarationsById.keys());
          if (next.hiddenModels !== undefined) {
            next.hiddenModels = next.hiddenModels.filter(
              (id) => !id.startsWith("selfhosted/") || declaredIds.has(id),
            );
            if (next.hiddenModels.length === 0) delete next.hiddenModels;
          }
        }

        if (patch.hiddenModels !== undefined) {
          if (patch.hiddenModels.length > MAX_HIDDEN_MODELS) {
            throw new ValidationError(`At most ${MAX_HIDDEN_MODELS} models may be hidden`);
          }
          if (patch.hiddenModels.length === 0) {
            delete next.hiddenModels;
          } else {
            // Sorted and deduplicated so a resubmitted hidden list compares equal
            // in `changedKeys` regardless of the order the toggles were flipped.
            const ids = [...new Set(patch.hiddenModels.map((id) => id.trim()))].sort();
            // A declaration in this same patch counts: it installs right after
            // the write below, so one PUT may declare and hide it together.
            const declaredNow = new Set((next.selfHostedModels ?? []).map((entry) => entry.id));
            const unknown = ids.filter(
              (id) => getModelConfig(id) === undefined && !declaredNow.has(id),
            );
            if (unknown.length > 0) {
              throw new ValidationError(`Unknown model ids: ${unknown.join(", ")}`);
            }
            // Judged against what `/api/models` would actually offer — the same
            // provider-channel narrowing (`offeredModels`, with this patch's
            // provider override when it carries one) — so a deployment with one
            // configured provider cannot hide that provider's whole list while
            // models no channel dispatches keep the guard quiet.
            const channelNames = (next.llmProviders ?? parseProviderConfigs(env)).map(
              (provider) => provider.name,
            );
            const remaining = offeredModels(channelNames, ids).filter(
              (model) => patch.selfHostedModels === undefined || model.provider !== "selfhosted",
            );
            const declaredVisible = offeredModels(channelNames, ids, next.selfHostedModels ?? []).length > 0;
            if (remaining.length === 0 && !declaredVisible) {
              throw new ValidationError("At least one model must remain visible");
            }
            next.hiddenModels = ids;
          }
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
         * `isConfiguredAdmin` false for everyone, revoking the project override at
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
      // Install what was just persisted: this process offers the declared
      // models immediately; other instances pick them up at their next
      // catalog tick, which re-reads the declarations (`localModels`).
      loadSelfHostedModels(next.selfHostedModels ?? []);
      // The row keeps only *which* keys were written, never their values: the
      // admin list is one of them and the LLM credential is another. Without
      // this the settings item held `updatedAt` and nothing about who moved it.
      await recordAudit({
        actorEmail: userEmail,
        action: "settings.update",
        target: auditTarget("settings", "app"),
        detail: changed.join(", ") || "no fields changed",
      });
      return toView(cipher, env, parseProviderConfigs, specs, next);
    },
  };
}
