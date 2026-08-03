/**
 * A workspace deciding its own settings.
 *
 * Deliberately not a second copy of `settingsUseCases`: the app row carries
 * infrastructure a workspace has no business touching, and the two write paths
 * would drift the moment one of them grew a field. What is shared is the list
 * of keys a workspace may decide (`TENANT_OVERRIDABLE_KEYS`) and the secret
 * lifecycle every stored credential already has — a masked value on update
 * preserves what is stored, because a mask can only confirm a secret, never
 * create one.
 */

import type { SecretCipher } from "@/domain/security/secretCipher";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings, LlmProviderSetting } from "@/domain/settings/types";
import { TENANT_OVERRIDABLE_KEYS, pickTenantOverrides } from "@/domain/settings/types";
import { ValidationError } from "@/application/errors";
import { DEFAULT_TENANT } from "@/shared/tenantContext";

/** Which keys are secrets, so a read masks them and a masked write keeps them. */
const SECRET_KEYS = new Set(["llmApiKey", "githubToken"]);

export interface TenantSettingsView {
  tenant: string;
  fields: Record<string, { value: string; source: "workspace" | "inherited"; secret: boolean }>;
  updatedAt?: string;
}

export interface TenantSettingsUseCases {
  getView(tenant: string): Promise<TenantSettingsView>;
  update(tenant: string, patch: Partial<AppSettings>): Promise<TenantSettingsView>;
}

function view(tenant: string, stored: AppSettings | null, cipher: SecretCipher): TenantSettingsView {
  const overrides = stored ? pickTenantOverrides(stored) : {};
  const fields: TenantSettingsView["fields"] = {};
  for (const key of TENANT_OVERRIDABLE_KEYS) {
    if (key === "llmProviders") {
      continue;
    }
    const value = overrides[key];
    const secret = SECRET_KEYS.has(key);
    fields[key] = {
      value: typeof value === "string" ? (secret ? cipher.mask(value) : value) : "",
      source: value === undefined ? "inherited" : "workspace",
      secret,
    };
  }
  return { tenant, fields, ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}) };
}

export function createTenantSettingsUseCases(
  repo: SettingsRepository,
  cipher: SecretCipher,
): TenantSettingsUseCases {
  return {
    async getView(tenant) {
      return view(tenant, await repo.getTenant(tenant), cipher);
    },

    async update(tenant, patch) {
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
        throw new ValidationError(
          `A workspace cannot override: ${rejected.sort().join(", ")}`,
        );
      }

      const stored = await repo.getTenant(tenant);
      const next: AppSettings = { ...(stored ?? { updatedAt: "" }) };
      for (const key of TENANT_OVERRIDABLE_KEYS) {
        const raw = patch[key];
        if (raw === undefined) {
          continue;
        }
        if (key === "llmProviders") {
          const providers = raw as LlmProviderSetting[];
          if (providers.length === 0) {
            delete next.llmProviders;
          } else {
            next.llmProviders = providers;
          }
          continue;
        }
        const value = String(raw).trim();
        if (value === "") {
          // Clearing falls back to the app layer, which is the only way a
          // workspace can undo a decision.
          delete next[key];
        } else if (SECRET_KEYS.has(key)) {
          if (!cipher.isMasked(value)) {
            next[key] = cipher.encrypt(value);
          }
        } else {
          next[key] = value;
        }
      }
      next.updatedAt = new Date().toISOString();
      await repo.putTenant(tenant, next);
      return view(tenant, next, cipher);
    },
  };
}
