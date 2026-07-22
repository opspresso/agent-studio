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
  getSlackBotToken,
  invalidateSettingsCache,
} from "@/lib/runtime-settings";
import { encryptSecret } from "@/lib/secret-encryption";

const mockGet = vi.mocked(settingsRepository.get);

function stub(settings: AppSettings | null): void {
  mockGet.mockResolvedValue(settings);
}

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "SLACK_BOT_TOKEN",
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
    process.env.SLACK_BOT_TOKEN = "xoxb-env";
    stub({
      adminEmails: "DB@Example.com, second@example.com",
      slackBotToken: encryptSecret("xoxb-db"),
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(await getAdminEmails()).toEqual(["db@example.com", "second@example.com"]);
    expect(await getSlackBotToken()).toBe("xoxb-db");
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
