process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsUseCases as createSettingsUseCasesImpl } from "@/application/settings/settingsUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";

// The cipher is injected now; every call below is unchanged.
const createSettingsUseCases = (repo: Parameters<typeof createSettingsUseCasesImpl>[0]) =>
  createSettingsUseCasesImpl(repo, secretCipher);
import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings } from "@/domain/settings/types";
import { decryptSecret, encryptSecret, isEncrypted } from "@/infrastructure/crypto/secretEncryption";

const ADMIN = "admin@example.com";

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "LLM_PROVIDER_OPENAI_BASE_URL",
  "LLM_PROVIDER_OPENAI_API_KEY",
  "ALLOWED_EMAIL_DOMAINS",
  "SKILLS_REPO",
  "SKILLS_REPO_BRANCH",
  "GITHUB_TOKEN",
  "A2A_API_KEY",
  "PUBLIC_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
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

function fakeRepo(initial: AppSettings | null = null): {
  repo: SettingsRepository;
  current: () => AppSettings | null;
} {
  let stored = initial;
  return {
    repo: {
      async get() {
        return stored;
      },
      async put(settings) {
        stored = settings;
      },
    },
    current: () => stored,
  };
}

describe("settingsUseCases.getView", () => {
  it("reports override/env/default/unset sources and masks secrets", async () => {
    const { repo } = fakeRepo({ updatedAt: "2026-01-01T00:00:00Z" });
    process.env.GITHUB_TOKEN = "ghp_env-token";

    const view = await createSettingsUseCases(repo).getView();

    expect(view.fields.githubToken).toEqual({
      // 13 chars → two revealed at each end.
      value: `gh${"•".repeat(9)}en`,
      source: "env",
      secret: true,
    });
    expect(view.fields.skillsRepoBranch).toEqual({
      value: "main",
      source: "default",
      secret: false,
    });
  });
});

describe("settingsUseCases.update", () => {
  it("encrypts new secrets, keeps masked ones, and removes cleared overrides", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await useCases.update({ a2aApiKey: "a2a-secret", skillsRepo: "org/repo" }, ADMIN);
    const storedKey = current()?.a2aApiKey;
    expect(isEncrypted(storedKey ?? "")).toBe(true);
    expect(decryptSecret(storedKey ?? "")).toBe("a2a-secret");

    await useCases.update({ a2aApiKey: "*".repeat("a2a-secret".length) }, ADMIN);
    expect(current()?.a2aApiKey).toBe(storedKey);

    await useCases.update({ a2aApiKey: "", skillsRepo: "" }, ADMIN);
    expect(current()?.a2aApiKey).toBeUndefined();
    expect(current()?.skillsRepo).toBeUndefined();
  });

  it("stores an LLM provider override, resolving masked keys from env, and clears on empty list", async () => {
    process.env.LLM_PROVIDER_OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_PROVIDER_OPENAI_API_KEY = "sk-env-openai";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update(
      {
        llmProviders: [
          { name: "OpenAI", baseUrl: "https://proxy.example.com/v1", apiKey: "********" },
          { name: "google", baseUrl: "https://g.example.com/v1", apiKey: "sk-new", keepModelPrefix: true },
        ],
      },
      ADMIN,
    );

    const stored = current()?.llmProviders;
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.name).toBe("openai");
    expect(decryptSecret(stored?.[0]?.apiKey ?? "")).toBe("sk-env-openai");
    expect(decryptSecret(stored?.[1]?.apiKey ?? "")).toBe("sk-new");
    expect(stored?.[1]?.keepModelPrefix).toBe(true);
    expect(view.llmProviders.source).toBe("override");
    expect(view.llmProviders.items[1]?.apiKey).toBe("*".repeat("sk-new".length));

    await useCases.update({ llmProviders: [] }, ADMIN);
    expect(current()?.llmProviders).toBeUndefined();
  });

  it("rejects a masked provider key with no stored or env value to keep", async () => {
    const { repo } = fakeRepo();
    await expect(
      createSettingsUseCases(repo).update(
        { llmProviders: [{ name: "xai", baseUrl: "https://u.example.com", apiKey: "****" }] },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps an existing encrypted provider key without encrypting it again", async () => {
    const encrypted = encryptSecret("sk-stored");
    const { repo, current } = fakeRepo({
      llmProviders: [
        { name: "openai", baseUrl: "https://old.example.com", apiKey: encrypted },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await createSettingsUseCases(repo).update(
      {
        llmProviders: [
          { name: "openai", baseUrl: "https://new.example.com", apiKey: "*********" },
        ],
      },
      ADMIN,
    );

    expect(current()?.llmProviders?.[0]?.apiKey).toBe(encrypted);
    expect(decryptSecret(current()?.llmProviders?.[0]?.apiKey ?? "")).toBe("sk-stored");
  });

  it("rejects providers outside the supported set", async () => {
    const { repo } = fakeRepo();
    await expect(
      createSettingsUseCases(repo).update(
        { llmProviders: [{ name: "mistral", baseUrl: "https://m.example.com", apiKey: "sk-m" }] },
        ADMIN,
      ),
    ).rejects.toThrow(/Unsupported LLM provider/);
  });

  it("rejects an adminEmails override that would lock the caller out", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await expect(
      useCases.update({ adminEmails: "other@example.com" }, ADMIN),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(current()).toBeNull();

    const view = await useCases.update({ adminEmails: `other@example.com, ${ADMIN}` }, ADMIN);
    expect(view.fields.adminEmails?.source).toBe("override");
  });

  it("rejects clearing the override when the env fallback would lock the caller out", async () => {
    process.env.ADMIN_EMAILS = "other@example.com";
    const { repo } = fakeRepo({ adminEmails: ADMIN, updatedAt: "2026-01-01T00:00:00Z" });

    await expect(
      createSettingsUseCases(repo).update({ adminEmails: "" }, ADMIN),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
