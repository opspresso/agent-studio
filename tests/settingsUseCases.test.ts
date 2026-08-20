process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSettingsUseCases as createSettingsUseCasesImpl } from "@/application/settings/settingsUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { parseProviderConfigs } from "@/infrastructure/llm/providers";

// The cipher is injected now; every call below is unchanged.
const createSettingsUseCases = (repo: Parameters<typeof createSettingsUseCasesImpl>[0]) =>
  createSettingsUseCasesImpl(repo, secretCipher, process.env, parseProviderConfigs);
import { ValidationError } from "@/application/errors";
import { getModelConfig, loadSelfHostedModels } from "@/domain/llm/models";
import type { SettingsRepository } from "@/domain/settings/repository";
import type { AppSettings } from "@/domain/settings/types";
import { decryptSecret, encryptSecret, isEncrypted } from "@/infrastructure/crypto/secretEncryption";

const ADMIN = "admin@example.com";

const ENV_KEYS = [
  "ADMIN_EMAILS",
  "LLM_PROVIDER_OPENAI_BASE_URL",
  "LLM_PROVIDER_OPENAI_API_KEY",
  "ALLOWED_EMAIL_DOMAINS",
  "PLUGINS_REPO",
  "PLUGINS_REPO_BRANCH",
  "GITHUB_TOKEN",
  "A2A_API_KEY",
  "PUBLIC_BASE_URL",
  "ARTIFACT_ACCESS_MODE",
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
   * The page posts every field on every save, so one save used to turn all ten
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
    process.env.A2A_API_KEY = "a2a-from-env";
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    const view = await useCases.update({ a2aApiKey: "a2a-from-env" }, ADMIN);

    expect(current()?.a2aApiKey).toBeUndefined();
    expect(view.fields.a2aApiKey?.source).toBe("env");
  });

  it("encrypts new secrets, keeps masked ones, and removes cleared overrides", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await useCases.update({ a2aApiKey: "a2a-secret", pluginsRepo: "org/repo" }, ADMIN);
    const storedKey = current()?.a2aApiKey;
    expect(isEncrypted(storedKey ?? "")).toBe(true);
    expect(decryptSecret(storedKey ?? "")).toBe("a2a-secret");

    await useCases.update({ a2aApiKey: "*".repeat("a2a-secret".length) }, ADMIN);
    expect(current()?.a2aApiKey).toBe(storedKey);

    await useCases.update({ a2aApiKey: "", pluginsRepo: "" }, ADMIN);
    expect(current()?.a2aApiKey).toBeUndefined();
    expect(current()?.pluginsRepo).toBeUndefined();
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

  it("stores enabledModels sorted and deduplicated, and clears on empty list", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);

    await useCases.update(
      { enabledModels: ["openai/gpt-5.4", "anthropic/claude-fable-5", "openai/gpt-5.4"] },
      ADMIN,
    );
    expect(current()?.enabledModels).toEqual(["anthropic/claude-fable-5", "openai/gpt-5.4"]);

    await useCases.update({ enabledModels: [] }, ADMIN);
    expect(current()?.enabledModels).toBeUndefined();
  });

  it("rejects enabledModels ids the registry does not carry", async () => {
    const { repo, current } = fakeRepo();

    await expect(
      createSettingsUseCases(repo).update(
        { enabledModels: ["openai/gpt-5.4", "openai/not-a-model"] },
        ADMIN,
      ),
    ).rejects.toThrow(/Unknown model ids: openai\/not-a-model/);
    expect(current()).toBeNull();
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

describe("settingsUseCases.update self-hosted declarations", () => {
  afterEach(() => {
    loadSelfHostedModels([]);
  });

  it("stores the full catalog-shaped entry, installs it, and clears on empty", async () => {
    const { repo, current } = fakeRepo();
    const useCases = createSettingsUseCases(repo);
    await useCases.update(
      {
        selfHostedModels: [
          {
            family: "qwen/qwen3.8-27b",
            displayName: "Qwen3.8 27B",
            contextWindow: 262144,
            maxTokens: 8192,
            capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
          },
        ],
      },
      ADMIN,
    );
    expect(current()?.selfHostedModels).toEqual([
      {
        id: "selfhosted/qwen/qwen3.8-27b",
        provider: "selfhosted",
        family: "qwen/qwen3.8-27b",
        // Defaulted from the family's vendor segment.
        maker: "qwen",
        displayName: "Qwen3.8 27B",
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
        contextWindow: 262144,
        maxTokens: 8192,
      },
    ]);
    // Installed for this process the moment it is saved.
    expect(getModelConfig("selfhosted/qwen/qwen3.8-27b")).toBeDefined();

    await useCases.update({ selfHostedModels: [] }, ADMIN);
    expect(current()?.selfHostedModels).toBeUndefined();
    expect(getModelConfig("selfhosted/qwen/qwen3.8-27b")).toBeUndefined();
  });

  it("lets one PUT declare a model and enable it together", async () => {
    const { repo, current } = fakeRepo();
    await createSettingsUseCases(repo).update(
      {
        selfHostedModels: [
          {
            family: "gemma-4-e4b",
            displayName: "Gemma 4 E4B",
            contextWindow: 131072,
            maxTokens: 8192,
            capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
          },
        ],
        // The declaration installs only after the write, so the enabled check
        // must count same-patch declarations rather than asking the registry.
        enabledModels: ["openai/gpt-5.4", "selfhosted/gemma-4-e4b"],
      },
      ADMIN,
    );
    expect(current()?.enabledModels).toEqual(["openai/gpt-5.4", "selfhosted/gemma-4-e4b"]);
  });

  it("fails the save on a declaration the registry would refuse", async () => {
    const { repo } = fakeRepo();
    await expect(
      createSettingsUseCases(repo).update(
        {
          selfHostedModels: [
            {
              family: "big",
              displayName: "Big",
              contextWindow: 100,
              maxTokens: 200,
              capabilities: {
                tools: false,
                structuredOutput: false,
                imageInput: false,
                reasoning: false,
              },
            },
          ],
        },
        ADMIN,
      ),
    ).rejects.toThrow(/maxTokens exceeds contextWindow/);
  });
});
