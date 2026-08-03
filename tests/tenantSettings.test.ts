process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/domain/settings/types";
import { TENANT_OVERRIDABLE_KEYS, pickTenantOverrides } from "@/domain/settings/types";

const { rows } = vi.hoisted(() => ({
  rows: { app: null as AppSettings | null, tenants: new Map<string, AppSettings>() },
}));

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: {
    get: async () => rows.app,
    put: async (settings: AppSettings) => {
      rows.app = settings;
    },
    getTenant: async (tenant: string) => rows.tenants.get(tenant) ?? null,
    putTenant: async (tenant: string, settings: AppSettings) => {
      rows.tenants.set(tenant, settings);
    },
  },
}));

const { getLlmChannelConfig, getUnknownModelPolicy, getSkillsRepoConfig, invalidateSettingsCache } =
  await import("@/lib/runtime-settings");
const { createTenantSettingsUseCases } = await import(
  "@/application/settings/tenantSettingsUseCases"
);
const { secretCipher } = await import("@/infrastructure/crypto/secretCipher");
const { settingsRepository } = await import(
  "@/infrastructure/db/repositories/settingsRepository"
);
const { encryptSecret } = await import("@/infrastructure/crypto/secretEncryption");
const { withTenant } = await import("@/shared/tenantContext");
const { ValidationError } = await import("@/application/errors");

const useCases = createTenantSettingsUseCases(settingsRepository, secretCipher);

beforeEach(() => {
  rows.app = null;
  rows.tenants.clear();
  invalidateSettingsCache();
  process.env.LLM_BASE_URL = "https://env.example/v1";
  process.env.LLM_API_KEY = "sk-env";
  delete process.env.UNKNOWN_MODEL_POLICY;
  delete process.env.SKILLS_REPO;
});

describe("resolution order", () => {
  it("is workspace over app over env over default", async () => {
    // Env only.
    expect((await getLlmChannelConfig()).baseUrl).toBe("https://env.example/v1");

    // App override wins over env.
    rows.app = { llmBaseUrl: "https://app.example/v1", updatedAt: "2026-01-01T00:00:00Z" };
    invalidateSettingsCache();
    expect((await getLlmChannelConfig()).baseUrl).toBe("https://app.example/v1");

    // Workspace override wins over both — but only inside that workspace.
    rows.tenants.set("acme", {
      llmBaseUrl: "https://acme.example/v1",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    invalidateSettingsCache();
    expect(await withTenant("acme", async () => (await getLlmChannelConfig()).baseUrl)).toBe(
      "https://acme.example/v1",
    );
    expect((await getLlmChannelConfig()).baseUrl).toBe("https://app.example/v1");
  });

  it("falls back through the layers key by key, not row by row", async () => {
    // A workspace deciding one key must not lose the app's answer for another.
    rows.app = {
      llmBaseUrl: "https://app.example/v1",
      skillsRepo: "org/app-skills",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    rows.tenants.set("acme", {
      llmBaseUrl: "https://acme.example/v1",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    invalidateSettingsCache();
    await withTenant("acme", async () => {
      expect((await getLlmChannelConfig()).baseUrl).toBe("https://acme.example/v1");
      expect((await getSkillsRepoConfig()).repo).toBe("org/app-skills");
    });
  });

  it("keeps one workspace's override invisible to another", async () => {
    rows.tenants.set("acme", { unknownModelPolicy: "refuse", updatedAt: "2026-01-01T00:00:00Z" });
    invalidateSettingsCache();
    expect(await withTenant("acme", getUnknownModelPolicy)).toBe("refuse");
    expect(await withTenant("globex", getUnknownModelPolicy)).toBe("allow");
    expect(await getUnknownModelPolicy()).toBe("allow");
  });

  it("ignores a stored key a workspace may not decide", async () => {
    // Written by hand, or left behind by a narrowing of the list: the
    // resolution reads through the allowed keys, so it never takes effect.
    rows.tenants.set("acme", {
      a2aApiKey: encryptSecret("asa_workspace-key"),
      allowedEmailDomains: "evil.example",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    rows.app = { allowedEmailDomains: "corp.example", updatedAt: "2026-01-01T00:00:00Z" };
    invalidateSettingsCache();
    const { getAllowedEmailDomains, getA2aApiKey } = await import("@/lib/runtime-settings");
    await withTenant("acme", async () => {
      expect(await getAllowedEmailDomains()).toEqual(["corp.example"]);
      expect(await getA2aApiKey()).toBeUndefined();
    });
  });
});

describe("the overridable list", () => {
  it("is defined in one place and drops everything else", () => {
    expect(
      pickTenantOverrides({
        llmBaseUrl: "https://acme.example/v1",
        a2aApiKey: "asa_x",
        adminEmails: "someone@x.com",
        publicBaseUrl: "https://acme.example",
      }),
    ).toEqual({ llmBaseUrl: "https://acme.example/v1" });
  });

  it("names the infrastructure keys it will not take, rather than dropping them silently", async () => {
    await expect(
      useCases.update("acme", { a2aApiKey: "asa_x", publicBaseUrl: "https://x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(useCases.update("acme", { a2aApiKey: "asa_x" })).rejects.toThrow(/a2aApiKey/);
  });

  it("refuses to give the default workspace a second row of its own", async () => {
    await expect(useCases.update("default", { llmBaseUrl: "https://x" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("workspace writes", () => {
  it("stores a secret encrypted and reads it back masked", async () => {
    const view = await useCases.update("acme", { llmApiKey: "sk-workspace-secret" });
    expect(rows.tenants.get("acme")?.llmApiKey).not.toBe("sk-workspace-secret");
    expect(view.fields.llmApiKey?.value).not.toContain("workspace");
    expect(view.fields.llmApiKey?.source).toBe("workspace");
  });

  it("keeps the stored secret when the mask is echoed back", async () => {
    await useCases.update("acme", { llmApiKey: "sk-workspace-secret" });
    const stored = rows.tenants.get("acme")?.llmApiKey;
    const masked = secretCipher.mask(stored!);
    await useCases.update("acme", { llmApiKey: masked });
    expect(rows.tenants.get("acme")?.llmApiKey).toBe(stored);
  });

  it("clears an override with an empty value, falling back to the app layer", async () => {
    rows.app = { llmBaseUrl: "https://app.example/v1", updatedAt: "2026-01-01T00:00:00Z" };
    await useCases.update("acme", { llmBaseUrl: "https://acme.example/v1" });
    await useCases.update("acme", { llmBaseUrl: "" });
    invalidateSettingsCache();
    expect(await withTenant("acme", async () => (await getLlmChannelConfig()).baseUrl)).toBe(
      "https://app.example/v1",
    );
  });

  it("reports every overridable key, inherited until the workspace decides it", async () => {
    const view = await useCases.getView("acme");
    const reported = new Set(Object.keys(view.fields));
    for (const key of TENANT_OVERRIDABLE_KEYS) {
      if (key !== "llmProviders") {
        expect(reported.has(key)).toBe(true);
      }
    }
    expect(view.fields.llmBaseUrl?.source).toBe("inherited");
  });
});
