process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/domain/settings/types";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: vi.fn(), put: vi.fn() },
}));

import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import {
  getAdminEmails,
  getLlmChannelConfig,
  getLlmProviderConfigs,
  getUnknownModelPolicy,
  invalidateSettingsCache,
  isAdminEmail,
  isConfiguredAdmin,
} from "@/lib/runtime-settings";
import { encryptSecret } from "@/infrastructure/crypto/secretEncryption";

const mockGet = vi.mocked(settingsRepository.get);

function stub(settings: AppSettings | null): void {
  mockGet.mockResolvedValue(settings);
}

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_PROVIDER_OPENAI_BASE_URL",
  "LLM_PROVIDER_OPENAI_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  invalidateSettingsCache();
  mockGet.mockReset();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("runtime settings precedence", () => {
  it("prefers DB overrides, decrypting secrets at read time", async () => {
    process.env.ADMIN_EMAILS = "env@example.com";
    stub({
      adminEmails: "DB@Example.com, second@example.com",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(await getAdminEmails()).toEqual(["db@example.com", "second@example.com"]);
  });

  it("falls back to env when no override is stored", async () => {
    process.env.ADMIN_EMAILS = "env@example.com";
    process.env.LLM_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_API_KEY = "sk-env";
    stub(null);

    expect(await getAdminEmails()).toEqual(["env@example.com"]);
    expect(await getLlmChannelConfig()).toEqual({
      baseUrl: "https://env.example.com/v1",
      apiKey: "sk-env",
    });
  });

  it("prefers stored LLM providers over LLM_PROVIDER_* env, decrypting keys", async () => {
    process.env.LLM_PROVIDER_OPENAI_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_PROVIDER_OPENAI_API_KEY = "sk-env";
    stub({
      llmProviders: [
        { name: "google", baseUrl: "https://g.example.com/v1", apiKey: encryptSecret("sk-db") },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(await getLlmProviderConfigs()).toEqual([
      { name: "google", baseUrl: "https://g.example.com/v1", apiKey: "sk-db", keepModelPrefix: false },
    ]);

    invalidateSettingsCache();
    stub(null);
    expect(await getLlmProviderConfigs()).toEqual([
      { name: "openai", baseUrl: "https://env.example.com/v1", apiKey: "sk-env", keepModelPrefix: false },
    ]);
  });

  it("caches reads until invalidated", async () => {
    stub({ adminEmails: "first@example.com", updatedAt: "2026-01-01T00:00:00Z" });
    expect(await getAdminEmails()).toEqual(["first@example.com"]);

    stub({ adminEmails: "second@example.com", updatedAt: "2026-01-02T00:00:00Z" });
    expect(await getAdminEmails()).toEqual(["first@example.com"]);
    expect(mockGet).toHaveBeenCalledTimes(1);

    invalidateSettingsCache();
    expect(await getAdminEmails()).toEqual(["second@example.com"]);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

/**
 * The two admin questions differ only on the unconfigured case, and that
 * difference is load-bearing: `isAdminEmail` gates shared-registry mutations,
 * where "no list" has always meant "no restriction"; `isConfiguredAdmin` gates
 * overriding someone else's project ownership, where the same reading would
 * hand every signed-in user write access to every project.
 */
describe("admin predicates", () => {
  it("both accept an address on the configured list", async () => {
    stub({ adminEmails: "ops@example.com, admin@example.com" } as AppSettings);
    await expect(isAdminEmail("admin@example.com")).resolves.toBe(true);
    await expect(isConfiguredAdmin("admin@example.com")).resolves.toBe(true);
  });

  it("both match the address case-insensitively", async () => {
    stub({ adminEmails: "admin@example.com" } as AppSettings);
    await expect(isAdminEmail("Admin@Example.com")).resolves.toBe(true);
    await expect(isConfiguredAdmin("ADMIN@EXAMPLE.COM")).resolves.toBe(true);
  });

  it("both reject an address off a configured list", async () => {
    stub({ adminEmails: "admin@example.com" } as AppSettings);
    await expect(isAdminEmail("someone@example.com")).resolves.toBe(false);
    await expect(isConfiguredAdmin("someone@example.com")).resolves.toBe(false);
  });

  it("diverge when no admin list is configured: open for registries, closed for ownership", async () => {
    stub(null);
    await expect(isAdminEmail("anyone@example.com")).resolves.toBe(true);
    await expect(isConfiguredAdmin("anyone@example.com")).resolves.toBe(false);
  });

  it("treats an admin list set to empty the same as unset", async () => {
    stub({ adminEmails: "  ,  " } as AppSettings);
    await expect(isConfiguredAdmin("anyone@example.com")).resolves.toBe(false);
  });
});

describe("unknown model policy", () => {
  it("defaults to allow, which is what every deployment had before it existed", async () => {
    delete process.env.UNKNOWN_MODEL_POLICY;
    stub(null);
    expect(await getUnknownModelPolicy()).toBe("allow");
  });

  it("reads refuse from the environment and from a stored override", async () => {
    process.env.UNKNOWN_MODEL_POLICY = "refuse";
    stub(null);
    expect(await getUnknownModelPolicy()).toBe("refuse");

    delete process.env.UNKNOWN_MODEL_POLICY;
    invalidateSettingsCache();
    stub({ unknownModelPolicy: "REFUSE", updatedAt: "2026-01-01T00:00:00Z" });
    expect(await getUnknownModelPolicy()).toBe("refuse");
  });

  it("reads anything else as allow, so a typo cannot take the platform down", async () => {
    stub({ unknownModelPolicy: "refuze", updatedAt: "2026-01-01T00:00:00Z" });
    expect(await getUnknownModelPolicy()).toBe("allow");
  });
});
