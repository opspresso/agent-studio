/**
 * A workspace deciding its own settings.
 *
 * Deliberately not a second copy of `settingsUseCases`: the app row carries
 * infrastructure a workspace has no business touching, and the two write paths
 * would drift the moment one of them grew a field. What is shared is the list
 * of keys a workspace may decide (`TENANT_OVERRIDABLE_KEYS`), which of them are
 * secrets (`SECRET_SETTING_KEYS`), and the secret lifecycle every stored
 * credential already has — a masked value on update preserves what is stored,
 * because a mask can only confirm a secret, never create one.
 */

import type { SecretCipher } from "@/domain/security/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, LlmProviderSetting } from "@/domain/settings/types";
import { TENANT_OVERRIDABLE_KEYS, pickTenantOverrides } from "@/domain/settings/types";
import { SECRET_SETTING_KEYS } from "./settingsUseCases";
import { recordAudit } from "@/application/audit/auditLog";
import { ValidationError } from "@/application/errors";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { DEFAULT_TENANT } from "@/shared/tenantContext";

/** Where a value came from, from this workspace's point of view. */
type FieldSource = "workspace" | "inherited";

export interface TenantSettingsView {
  tenant: string;
  fields: Record<string, { value: string; source: FieldSource; secret: boolean }>;
  /**
   * Reported with the same shape the app view uses, because a workspace that
   * can *set* providers has to be able to see and clear them. Leaving it out
   * showed a workspace as inheriting the deployment's providers while it was
   * actually overriding them, with no way to tell and no way to undo.
   */
  llmProviders: {
    source: FieldSource;
    items: { name: string; baseUrl: string; apiKey: string; keepModelPrefix: boolean }[];
  };
  updatedAt?: string;
}

export interface TenantSettingsUpdate {
  llmProviders?: { name: string; baseUrl: string; apiKey: string; keepModelPrefix?: boolean }[];
  [key: string]: unknown;
}

export interface TenantSettingsUseCases {
  getView(tenant: string): Promise<TenantSettingsView>;
  update(
    tenant: string,
    patch: TenantSettingsUpdate,
    userEmail: string,
  ): Promise<TenantSettingsView>;
}

function isSecret(key: string): boolean {
  return (SECRET_SETTING_KEYS as ReadonlySet<string>).has(key);
}

function view(tenant: string, stored: AppSettings | null, cipher: SecretCipher): TenantSettingsView {
  const overrides = stored ? pickTenantOverrides(stored) : {};
  const fields: TenantSettingsView["fields"] = {};
  for (const key of TENANT_OVERRIDABLE_KEYS) {
    if (key === "llmProviders") {
      continue;
    }
    const value = overrides[key];
    const secret = isSecret(key);
    fields[key] = {
      value: typeof value === "string" ? (secret ? cipher.mask(value) : value) : "",
      source: value === undefined ? "inherited" : "workspace",
      secret,
    };
  }
  const providers = overrides.llmProviders;
  return {
    tenant,
    fields,
    llmProviders: {
      source: providers === undefined ? "inherited" : "workspace",
      items: (providers ?? []).map((provider) => ({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: cipher.mask(provider.apiKey),
        keepModelPrefix: provider.keepModelPrefix ?? false,
      })),
    },
    ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/**
 * One submitted provider row in its stored form. A masked apiKey keeps what the
 * workspace already stored for that provider — and only that: unlike the app
 * path there is no environment to fall back to, because a workspace's providers
 * are its own or they are the deployment's whole list, never a mix.
 */
function toProviderSetting(
  cipher: SecretCipher,
  input: NonNullable<TenantSettingsUpdate["llmProviders"]>[number],
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
  if (!cipher.isMasked(apiKey)) {
    if (!apiKey) {
      throw new ValidationError(`LLM provider "${name}" needs an API key`);
    }
    return {
      name,
      baseUrl,
      apiKey: cipher.encrypt(apiKey),
      ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
    };
  }
  const existing = stored?.find((provider) => provider.name === name)?.apiKey;
  if (existing === undefined) {
    throw new ValidationError(`LLM provider "${name}" needs an API key (no stored value to keep)`);
  }
  return {
    name,
    baseUrl,
    apiKey: existing,
    ...(input.keepModelPrefix ? { keepModelPrefix: true } : {}),
  };
}

export function createTenantSettingsUseCases(
  repo: SettingsRepository,
  cipher: SecretCipher,
): TenantSettingsUseCases {
  return {
    async getView(tenant) {
      return view(tenant, await repo.getTenant(tenant), cipher);
    },

    async update(tenant, patch, userEmail) {
      if (tenant === DEFAULT_TENANT) {
        // The default workspace *is* the deployment: letting it hold overrides
        // would give the same deployment two rows saying different things, with
        // the app settings page editing only one of them.
        throw new ValidationError(
          "The default workspace has no separate settings; use the app settings page",
        );
      }
      const rejected = Object.keys(patch).filter(
        (key) => !(TENANT_OVERRIDABLE_KEYS as readonly string[]).includes(key),
      );
      if (rejected.length > 0) {
        // Named rather than silently dropped: an operator who tried to set one
        // needs to know it will never take effect.
        throw new ValidationError(`A workspace cannot override: ${rejected.sort().join(", ")}`);
      }

      const stored = await repo.getTenant(tenant);
      const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
      for (const key of TENANT_OVERRIDABLE_KEYS) {
        const raw = patch[key];
        if (raw === undefined) {
          continue;
        }
        if (key === "llmProviders") {
          const submitted = patch.llmProviders ?? [];
          if (submitted.length === 0) {
            delete next.llmProviders;
            continue;
          }
          const providers = submitted.map((input) =>
            toProviderSetting(cipher, input, stored?.llmProviders),
          );
          if (new Set(providers.map((provider) => provider.name)).size !== providers.length) {
            throw new ValidationError("LLM provider names must be unique");
          }
          next.llmProviders = providers;
          continue;
        }
        const value = String(raw).trim();
        if (value === "") {
          // Clearing falls back to the app layer, which is the only way a
          // workspace can undo a decision.
          delete next[key];
        } else if (isSecret(key)) {
          if (!cipher.isMasked(value)) {
            next[key] = cipher.encrypt(value);
          }
        } else {
          next[key] = value;
        }
      }
      next.updatedAt = new Date().toISOString();
      await repo.putTenant(tenant, next);
      // Which keys, never their values — the same contract the app row's write
      // has, and for the same reason: this path writes credentials too.
      await recordAudit({
        action: "settings.update",
        actorEmail: userEmail,
        target: `settings:workspace:${tenant}`,
        detail: `keys: ${Object.keys(patch).sort().join(", ") || "none"}`,
      });
      return view(tenant, next, cipher);
    },
  };
}
