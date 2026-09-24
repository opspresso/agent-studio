process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRegistrations } from "./modelFixtures";
import type { AppSettings } from "@/domain/settings/types";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: vi.fn(), put: vi.fn() },
}));

import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import {
  getArtifactAccessMode,
  getAdminEmails,
  getEmbeddingModelSelection,
  getEmbeddingTarget,
  getLlmProviderConfigs,
  getPluginsRepoConfig,
  getRerankerModelSelection,
  getRerankerModel,
  getRerankerTarget,
  getRerankerMinScoreSelection,
  invalidateSettingsCache,
  isAdminEmail,
  isConfiguredAdmin,
} from "@/lib/runtime-settings";
import { encryptSecret } from "@/infrastructure/crypto/secretEncryption";
import {
  llmProviderApiKeyContext,
  settingsSecretContext,
} from "@/domain/security/secretContext";

const mockGet = vi.mocked(settingsRepository.get);

function stub(settings: AppSettings | null): void {
  mockGet.mockResolvedValue(settings ? { registeredModels: fixtureRegistrations(), ...settings } : null);
}

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "LLM_PROVIDER_OPENAI_BASE_URL",
  "LLM_PROVIDER_OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "ARTIFACT_ACCESS_MODE",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "RERANKER_MODEL",
  "RERANKER_BASE_URL",
  "RERANKER_API_KEY",
  "RERANKER_MIN_SCORE",
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
  invalidateSettingsCache();
  mockGet.mockReset();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("runtime settings precedence", () => {
  it("resolves artifact access securely from DB, env, or the authenticated default", async () => {
    process.env.ARTIFACT_ACCESS_MODE = "public";
    stub({ artifactAccessMode: "authenticated", updatedAt: "2026-01-01T00:00:00Z" });
    await expect(getArtifactAccessMode()).resolves.toBe("authenticated");

    invalidateSettingsCache();
    stub(null);
    await expect(getArtifactAccessMode()).resolves.toBe("public");

    invalidateSettingsCache();
    process.env.ARTIFACT_ACCESS_MODE = "typo";
    await expect(getArtifactAccessMode()).resolves.toBe("authenticated");
  });

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
    stub(null);

    expect(await getAdminEmails()).toEqual(["env@example.com"]);
  });

  it("prefers stored LLM providers over LLM_PROVIDER_* env, decrypting keys", async () => {
    process.env.LLM_PROVIDER_OPENAI_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_PROVIDER_OPENAI_API_KEY = "sk-env";
    stub({
      llmProviders: [
        {
          name: "google",
          baseUrl: "https://g.example.com/v1",
          apiKey: encryptSecret(
            "sk-db",
            llmProviderApiKeyContext("google", "https://g.example.com/v1"),
          ),
        },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    });

    expect(await getLlmProviderConfigs()).toEqual([
      {
        name: "google",
        baseUrl: "https://g.example.com/v1",
        apiKey: "sk-db",
        keepModelPrefix: false,
        auth: "bearer",
      },
    ]);

    invalidateSettingsCache();
    stub(null);
    expect(await getLlmProviderConfigs()).toEqual([
      {
        name: "openai",
        baseUrl: "https://env.example.com/v1",
        apiKey: "sk-env",
        keepModelPrefix: false,
        auth: "bearer",
      },
    ]);
  });

  it("decrypts the stored GitHub setting", async () => {
    stub({
      pluginsRepo: "org/plugins",
      githubToken: encryptSecret("gh-secret", settingsSecretContext("github-token")),
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await expect(getPluginsRepoConfig()).resolves.toMatchObject({
      repo: "org/plugins",
      token: "gh-secret",
    });
  });

  it("routes public retrieval models with their provider URL, scoped credential and wire id", async () => {
    process.env.EMBEDDING_BASE_URL = "http://spark.test:8001/v1";
    process.env.RERANKER_BASE_URL = "http://spark.test:8002/v1";
    process.env.RERANKER_MODEL = "selfhosted/Qwen/Qwen3-Reranker-0.6B";
    const baseUrl = "https://router.test/api/v1";
    stub({
      llmProviders: [{
        name: "openrouter", baseUrl,
        apiKey: encryptSecret("router-secret", llmProviderApiKeyContext("openrouter", baseUrl)),
      }, {
        name: "selfhosted", baseUrl: "http://spark.test:8000/v1", apiKey: encryptSecret("chat-key"),
      }],
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await expect(getEmbeddingTarget("openrouter/text-embedding-3-small")).resolves.toMatchObject({
      baseUrl, apiKey: "router-secret", model: "openai/text-embedding-3-small",
    });
    await expect(getRerankerTarget("openrouter/rerank-2.5")).resolves.toMatchObject({
      baseUrl, apiKey: "router-secret", model: "voyageai/rerank-2.5",
    });

  });

  it("preserves provider model prefixes when the retrieval channel requires them", async () => {
    stub({
      llmProviders: [{
        name: "openrouter", baseUrl: "https://router.test/v1", apiKey: encryptSecret("router-key"),
        keepModelPrefix: true,
      }],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await expect(getRerankerTarget("openrouter/rerank-2.5")).resolves.toMatchObject({
      model: "openrouter/rerank-2.5",
    });
  });

  it("refuses retrieval without a registered provider instead of using legacy endpoints", async () => {
    process.env.EMBEDDING_BASE_URL = "http://embedding.test/v1";
    process.env.EMBEDDING_API_KEY = "embedding-key";
    process.env.RERANKER_BASE_URL = "http://reranker.test/v1";
    process.env.RERANKER_MODEL = "voyageai/rerank-2.5";
    process.env.RERANKER_API_KEY = "reranker-key";
    stub({ llmProviders: [], updatedAt: "2026-01-01T00:00:00Z" });

    await expect(getEmbeddingTarget("openrouter/text-embedding-3-small")).rejects.toThrow("registered embedding");
    await expect(getRerankerTarget("openrouter/rerank-2.5")).rejects.toThrow("registered rerank");
  });

  it("refuses to send unsigned retrieval requests to a SigV4 provider", async () => {
    stub({
      llmProviders: [{ name: "openrouter", baseUrl: "https://signed.test/v1", auth: "sigv4", apiKey: "" }],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await expect(getRerankerTarget("openrouter/rerank-2.5")).rejects.toThrow("API-key provider");
    await expect(getEmbeddingTarget("openrouter/text-embedding-3-small")).rejects.toThrow("API-key provider");
  });

  it("resolves embedding and reranker selections from DB before env", async () => {
    process.env.EMBEDDING_MODEL = "openrouter/qwen3-embedding-4b";
    process.env.RERANKER_MODEL = "selfhosted/env-reranker";
    stub({
      embeddingModel: "selfhosted/Qwen/Qwen3-Embedding-4B",
      rerankerModel: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await expect(getEmbeddingModelSelection()).resolves.toEqual({
      model: "selfhosted/Qwen/Qwen3-Embedding-4B",
      source: "override",
    });
    await expect(getRerankerModelSelection()).resolves.toEqual({
      model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      source: "override",
    });

    invalidateSettingsCache();
    stub(null);
    await expect(getEmbeddingModelSelection()).resolves.toEqual({
      model: "",
      source: "default",
    });
    await expect(getRerankerModelSelection()).resolves.toBeUndefined();
  });

  it("names the model usage setting when no reranker is selected", async () => {
    stub(null);
    await expect(getRerankerModel()).rejects.toThrow("Select a reranker model in model usage settings");
  });

  it("resolves the reranker score floor from DB before env and default", async () => {
    process.env.RERANKER_MIN_SCORE = "0.2";
    stub({ rerankerMinScore: "0.3", updatedAt: "2026-01-01T00:00:00Z" });
    await expect(getRerankerMinScoreSelection()).resolves.toEqual({
      value: 0.3,
      source: "override",
    });

    invalidateSettingsCache();
    stub(null);
    await expect(getRerankerMinScoreSelection()).resolves.toEqual({ value: 0.2, source: "env" });

    invalidateSettingsCache();
    delete process.env.RERANKER_MIN_SCORE;
    await expect(getRerankerMinScoreSelection()).resolves.toEqual({ value: 0.01, source: "default" });
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

  it("shares one database read across concurrent cache misses", async () => {
    let resolveRead!: (value: AppSettings) => void;
    mockGet.mockImplementation(
      () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const admins = getAdminEmails();
    const plugins = getPluginsRepoConfig();
    expect(mockGet).toHaveBeenCalledTimes(1);

    resolveRead({
      adminEmails: "admin@example.com",
      pluginsRepo: "org/plugins",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    await expect(admins).resolves.toEqual(["admin@example.com"]);
    await expect(plugins).resolves.toMatchObject({ repo: "org/plugins" });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("does not let an earlier read repopulate the cache after invalidation", async () => {
    let resolveFirst!: (value: AppSettings) => void;
    mockGet
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({ adminEmails: "new@example.com", updatedAt: "2026-01-02T00:00:00Z" });

    const staleRead = getAdminEmails();
    invalidateSettingsCache();
    resolveFirst({ adminEmails: "old@example.com", updatedAt: "2026-01-01T00:00:00Z" });
    expect(await staleRead).toEqual(["old@example.com"]);
    expect(await getAdminEmails()).toEqual(["new@example.com"]);
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
