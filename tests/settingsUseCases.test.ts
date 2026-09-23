process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsUseCases as createSettingsUseCasesImpl } from "@/application/settings/settingsUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";

// The cipher is injected now; every call below is unchanged.
const createSettingsUseCases = (repo: Parameters<typeof createSettingsUseCasesImpl>[0]) =>
  createSettingsUseCasesImpl(repo, secretCipher, process.env, parseProviderConfigs);
import { ValidationError } from "@/application/errors";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings } from "@/domain/settings/types";
import { fixtureRegistrations } from "./modelFixtures";
import { decryptSecret, encryptSecret, isEncrypted } from "@/infrastructure/crypto/secretEncryption";
import {
  llmApiKeyContext,
  llmProviderApiKeyContext,
  settingsSecretContext,
} from "@/domain/security/secretContext";

const ADMIN = "admin@example.com";

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_PROVIDER_OPENAI_BASE_URL",
  "LLM_PROVIDER_OPENAI_API_KEY",
  "ALLOWED_EMAIL_DOMAINS",
  "PLUGINS_REPO",
  "PLUGINS_REPO_BRANCH",
  "GITHUB_TOKEN",
  "PUBLIC_BASE_URL",
  "ARTIFACT_ACCESS_MODE",
  "EMBEDDING_MODEL",
  "RERANKER_MODEL",
  "RERANKER_MIN_SCORE",
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
      async update(mutate) {
        const before = stored;
        const after = mutate(stored);
        stored = after;
        return { before, after };
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
      // 13 chars → four revealed at each end.
      value: `ghp_${"•".repeat(5)}oken`,
      source: "env",
      secret: true,
    });
    expect(view.fields.pluginsRepoBranch).toEqual({
      value: "main",
      source: "default",
      secret: false,
    });
    expect(view.fields.artifactAccessMode).toEqual({
      value: "authenticated",
      source: "default",
      secret: false,
    });
  });
});

describe("settingsUseCases.update access-control guards", () => {
  /*
   * The boot guard reads the env var once and never runs again, so these two
   * lists are the one place an operator can make a deployed stage fail open
   * after boot. "Present but parses to nothing" is the dangerous shape: unlike
   * clearing the field, it does not fall back to the env var.
   */
  it.each([
    ["adminEmails", ","],
    ["adminEmails", "  ;  "],
    ["allowedEmailDomains", ","],
  ])("rejects a %s override that parses to nothing (%j)", async (key, value) => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await expect(useCases.update({ [key]: value }, ADMIN)).rejects.toBeInstanceOf(ValidationError);
    expect(current()).toBeNull();
  });

  it("still lets an empty string clear the override and fall back to env", async () => {
    process.env.ADMIN_EMAILS = ADMIN;
    const { repo, current } = fakeRepo({ adminEmails: ADMIN, updatedAt: "2026-01-01T00:00:00.000Z" });
    const useCases = createSettingsUseCases(repo);

    await useCases.update({ adminEmails: "" }, ADMIN);

    expect(current()?.adminEmails).toBeUndefined();
  });

  it("refuses an admin list that would lock the caller out", async () => {
    const { repo } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await expect(
      useCases.update({ adminEmails: "someone-else@example.com" }, ADMIN),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("settingsUseCases.update", () => {
  it("merges a patch against the latest row inside the repository update", async () => {
    let stored: AppSettings = {
      embeddingModel: "openai/text-embedding-3-small",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const repo: SettingsRepository = {
      get: async () => {
        throw new Error("a settings write must not take a stale preliminary read");
      },
      update: async (mutate) => {
        const before = stored;
        const after = mutate(stored);
        stored = after;
        return { before, after };
      },
    };

    await createSettingsUseCases(repo).update(
      { publicBaseUrl: "https://studio.example.com" },
      ADMIN,
    );

    expect(stored).toMatchObject({
      embeddingModel: "openai/text-embedding-3-small",
      publicBaseUrl: "https://studio.example.com",
    });
  });

  it("stores selected models independently of legacy environment values", async () => {
    process.env.EMBEDDING_MODEL = "openrouter/qwen3-embedding-4b";
    process.env.RERANKER_MODEL = "selfhosted/env-reranker";
    const { repo, current } = fakeRepo({ registeredModels: fixtureRegistrations(), updatedAt: "" });
    const useCases = createSettingsUseCases(repo);
    await useCases.update(
      {
        embeddingModel: "openai/text-embedding-3-small",
        rerankerModel: "openrouter/rerank-2.5",
      },
      ADMIN,
    );
    expect(current()?.embeddingModel).toBe("openai/text-embedding-3-small");
    expect(current()?.rerankerModel).toBe("openrouter/rerank-2.5");

    await useCases.update({ embeddingModel: "", rerankerModel: "" }, ADMIN);
    expect(current()?.embeddingModel).toBeUndefined();
    expect(current()?.rerankerModel).toBeUndefined();
  });

  it("stores a valid reranker score floor and rejects values outside zero to one", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await useCases.update({ rerankerMinScore: "0.05" }, ADMIN);
    expect(current()?.rerankerMinScore).toBe("0.05");

    await expect(useCases.update({ rerankerMinScore: "1.1" }, ADMIN)).rejects.toThrow(
      "Reranker minimum score must be between 0 and 1",
    );
    await expect(useCases.update({ rerankerMinScore: "not-a-number" }, ADMIN)).rejects.toThrow(
      "Reranker minimum score must be between 0 and 1",
    );

    await useCases.update({ rerankerMinScore: "0.01" }, ADMIN);
    expect(current()?.rerankerMinScore).toBeUndefined();
  });

  it("stores a public artifact mode override and clears it back to the environment", async () => {
    process.env.ARTIFACT_ACCESS_MODE = "authenticated";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    let view = await useCases.update({ artifactAccessMode: "public" }, ADMIN);
    expect(current()?.artifactAccessMode).toBe("public");
    expect(view.fields.artifactAccessMode?.source).toBe("override");

    view = await useCases.update({ artifactAccessMode: "" }, ADMIN);
    expect(current()?.artifactAccessMode).toBeUndefined();
    expect(view.fields.artifactAccessMode?.value).toBe("authenticated");
    expect(view.fields.artifactAccessMode?.source).toBe("env");
  });

  it("rejects an unknown artifact access mode at the use-case boundary", async () => {
    const { repo, current } = fakeRepo();

    await expect(
      createSettingsUseCases(repo).update({ artifactAccessMode: "private" }, ADMIN),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(current()).toBeNull();
  });

  /**
   * The page posts every field on every save, so one save would turn all ten
   * into overrides — each reading `override` next to the value it was already
   * inheriting, and each one shadowing the env var from then on. A value equal
   * to the environment's is therefore not an override at all.
   */
  it("does not store a value the environment already provides", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "nalbam.com";
    process.env.PLUGINS_REPO = "opspresso/agent-plugins";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update(
      { allowedEmailDomains: "nalbam.com", pluginsRepo: "opspresso/other" },
      ADMIN,
    );

    expect(current()?.allowedEmailDomains).toBeUndefined();
    expect(view.fields.allowedEmailDomains?.source).toBe("env");
    expect(view.fields.allowedEmailDomains?.value).toBe("nalbam.com");
    // The one that differs is still stored, which is what an override is for.
    expect(current()?.pluginsRepo).toBe("opspresso/other");
    expect(view.fields.pluginsRepo?.source).toBe("override");
  });

  /** Resaving the same value is how an override left over from before is cleared. */
  it("drops an existing override once it matches the environment", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "nalbam.com";
    const { repo, current } = fakeRepo({
      allowedEmailDomains: "nalbam.com",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update({ allowedEmailDomains: "nalbam.com" }, ADMIN);

    expect(current()?.allowedEmailDomains).toBeUndefined();
    expect(view.fields.allowedEmailDomains?.source).toBe("env");
  });

  it("does not store a secret the environment already provides", async () => {
    process.env.GITHUB_TOKEN = "github-from-env";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update({ githubToken: "github-from-env" }, ADMIN);

    expect(current()?.githubToken).toBeUndefined();
    expect(view.fields.githubToken?.source).toBe("env");
  });

  it("encrypts new secrets, keeps masked ones, and removes cleared overrides", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await useCases.update({ githubToken: "github-secret", pluginsRepo: "org/repo" }, ADMIN);
    const storedKey = current()?.githubToken;
    expect(isEncrypted(storedKey ?? "")).toBe(true);
    expect(decryptSecret(storedKey ?? "", settingsSecretContext("github-token"))).toBe(
      "github-secret",
    );

    await useCases.update({ githubToken: "*".repeat("github-secret".length) }, ADMIN);
    expect(current()?.githubToken).toBe(storedKey);

    await useCases.update({ githubToken: "", pluginsRepo: "" }, ADMIN);
    expect(current()?.githubToken).toBeUndefined();
    expect(current()?.pluginsRepo).toBeUndefined();
  });

  it("stores an LLM provider override, resolving masked keys from env, and disables providers on an empty list", async () => {
    process.env.LLM_PROVIDER_OPENAI_BASE_URL = "https://api.openai.com/v1";
    process.env.LLM_PROVIDER_OPENAI_API_KEY = "sk-env-openai";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update(
      {
        llmProviders: [
          { name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "********" },
          { name: "google", baseUrl: "https://g.example.com/v1", apiKey: "sk-new", keepModelPrefix: true },
        ],
      },
      ADMIN,
    );

    const stored = current()?.llmProviders;
    expect(stored).toHaveLength(2);
    expect(stored?.[0]?.name).toBe("openai");
    expect(
      decryptSecret(
        stored?.[0]?.apiKey ?? "",
        llmProviderApiKeyContext("openai", "https://api.openai.com/v1"),
      ),
    ).toBe("sk-env-openai");
    expect(
      decryptSecret(
        stored?.[1]?.apiKey ?? "",
        llmProviderApiKeyContext("google", "https://g.example.com/v1"),
      ),
    ).toBe("sk-new");
    expect(stored?.[1]?.keepModelPrefix).toBe(true);
    expect(view.llmProviders.source).toBe("override");
    expect(view.llmProviders.items[1]?.apiKey).toBe("*".repeat("sk-new".length));

    await useCases.update({ llmProviders: [] }, ADMIN);
    expect(current()?.llmProviders).toEqual([]);
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

  it("registers multiple self-hosted connections without requiring API keys", async () => {
    const { repo, current } = fakeRepo();
    const view = await createSettingsUseCases(repo).update({ llmProviders: [
      { name: "local-text", kind: "selfhosted", baseUrl: "http://localhost:8000/v1/", apiKey: "" },
      { name: "local-embedding", kind: "selfhosted", baseUrl: "http://localhost:8001/v1", apiKey: "" },
    ] }, ADMIN);
    expect(view.llmProviders.items.map(provider => provider.kind)).toEqual(["selfhosted", "selfhosted"]);
    expect(current()?.llmProviders?.[0]).toMatchObject({ name: "local-text", baseUrl: "http://localhost:8000/v1", apiKey: "" });
  });

  it("preserves an existing key on blank input but refuses to carry it to a different provider kind", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);
    const provider = { name: "office", kind: "openai" as const, baseUrl: "https://provider.example/v1", apiKey: "secret-key" };
    await useCases.update({ llmProviders: [provider] }, ADMIN);
    const key = current()?.llmProviders?.[0]?.apiKey;
    await useCases.update({ llmProviders: [{ ...provider, apiKey: "" }] }, ADMIN);
    expect(current()?.llmProviders?.[0]?.apiKey).toBe(key);
    await expect(useCases.update({ llmProviders: [{ ...provider, kind: "anthropic", apiKey: "" }] }, ADMIN)).rejects.toThrow("requires a new API key");
  });

  it("rejects provider URLs containing inline credentials before storing anything", async () => {
    const { repo, current } = fakeRepo();
    await expect(createSettingsUseCases(repo).update({ llmProviders: [{ name: "openai", baseUrl: "https://provider.example/v1?key=secret", apiKey: "new-key" }] }, ADMIN)).rejects.toThrow("Provider URL");
    expect(current()).toBeNull();
  });

  it("keeps an existing provider key only while its endpoint and auth stay the same", async () => {
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
          { name: "openai", baseUrl: "https://old.example.com", apiKey: "*********" },
        ],
      },
      ADMIN,
    );

    expect(current()?.llmProviders?.[0]?.apiKey).toBe(encrypted);
    expect(decryptSecret(current()?.llmProviders?.[0]?.apiKey ?? "")).toBe("sk-stored");
  });

  it("requires a new provider key when its endpoint changes", async () => {
    const encrypted = encryptSecret("sk-stored");
    const { repo, current } = fakeRepo({
      llmProviders: [
        { name: "openai", baseUrl: "https://old.example.com", apiKey: encrypted },
      ],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const useCases = createSettingsUseCases(repo);

    await expect(
      useCases.update(
        {
          llmProviders: [
            { name: "openai", baseUrl: "https://new.example.com", apiKey: "*********" },
          ],
        },
        ADMIN,
      ),
    ).rejects.toThrow(/requires a new API key/);

    await useCases.update(
      {
        llmProviders: [
          { name: "openai", baseUrl: "https://new.example.com", apiKey: "sk-new" },
        ],
      },
      ADMIN,
    );
    expect(
      decryptSecret(
        current()?.llmProviders?.[0]?.apiKey ?? "",
        llmProviderApiKeyContext("openai", "https://new.example.com"),
      ),
    ).toBe("sk-new");
  });

  it("requires a new default key when LLM_BASE_URL changes", async () => {
    process.env.LLM_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_API_KEY = "sk-env";
    const { repo, current } = fakeRepo({
      llmBaseUrl: "https://old.example.com/v1",
      llmApiKey: encryptSecret("sk-old"),
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const useCases = createSettingsUseCases(repo);

    await expect(
      useCases.update(
        { llmBaseUrl: "https://new.example.com/v1", llmApiKey: "******" },
        ADMIN,
      ),
    ).rejects.toThrow("Changing LLM_BASE_URL requires a new LLM_API_KEY");

    await useCases.update(
      { llmBaseUrl: "https://new.example.com/v1", llmApiKey: "sk-new" },
      ADMIN,
    );
    expect(current()?.llmBaseUrl).toBe("https://new.example.com/v1");
    expect(
      decryptSecret(
        current()?.llmApiKey ?? "",
        llmApiKeyContext("https://new.example.com/v1"),
      ),
    ).toBe("sk-new");
  });

  it("refuses a stored default endpoint without its own key", async () => {
    process.env.LLM_API_KEY = "sk-env";
    const { repo } = fakeRepo({
      llmBaseUrl: "https://stored.example.com/v1",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await expect(
      createSettingsUseCases(repo).update({ pluginsRepo: "org/repo" }, ADMIN),
    ).rejects.toThrow("A stored LLM_BASE_URL requires a stored LLM_API_KEY");
  });

  it("can clear both default channel overrides back to the environment pair", async () => {
    process.env.LLM_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_API_KEY = "sk-env";
    const { repo, current } = fakeRepo({
      llmBaseUrl: "https://stored.example.com/v1",
      llmApiKey: encryptSecret("sk-stored"),
      updatedAt: "2026-01-01T00:00:00Z",
    });

    await createSettingsUseCases(repo).update({ llmBaseUrl: "", llmApiKey: "" }, ADMIN);

    expect(current()?.llmBaseUrl).toBeUndefined();
    expect(current()?.llmApiKey).toBeUndefined();
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
