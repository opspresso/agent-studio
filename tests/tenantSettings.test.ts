process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventInput } from "@/domain/audit/types";
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
const { setAuditSink } = await import("@/application/audit/auditLog");

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

describe("invalidation", () => {
  it("drops only the workspace that changed", async () => {
    // A workspace save used to clear the whole map, so one admin pressing Save
    // charged every other workspace on the instance a fresh read of a row that
    // had not changed.
    rows.tenants.set("acme", { llmBaseUrl: "https://acme.example/v1", updatedAt: "" });
    rows.tenants.set("globex", { llmBaseUrl: "https://globex.example/v1", updatedAt: "" });
    let reads = 0;
    const counting = { ...settingsRepository };
    vi.spyOn(settingsRepository, "getTenant").mockImplementation(async (tenant: string) => {
      reads += 1;
      return counting.getTenant(tenant);
    });

    for (const tenant of ["acme", "globex"]) {
      await withTenant(tenant, () => getLlmChannelConfig());
    }
    expect(reads).toBe(2);

    invalidateSettingsCache("acme");
    expect(
      (await withTenant("globex", () => getLlmChannelConfig())).baseUrl,
    ).toBe("https://globex.example/v1");
    expect(reads).toBe(2);

    rows.tenants.set("acme", { llmBaseUrl: "https://acme-2.example/v1", updatedAt: "" });
    expect((await withTenant("acme", () => getLlmChannelConfig())).baseUrl).toBe(
      "https://acme-2.example/v1",
    );
    expect(reads).toBe(3);
    vi.mocked(settingsRepository.getTenant).mockRestore();
  });

  it("drops every workspace when the deployment's own row changes", async () => {
    // The app row is what a workspace view inherits from, so a change to it
    // invalidates all of them.
    rows.tenants.set("acme", { llmApiKey: encryptSecret("sk-acme"), updatedAt: "" });
    rows.app = { llmBaseUrl: "https://app.example/v1", updatedAt: "" };
    expect((await withTenant("acme", () => getLlmChannelConfig())).baseUrl).toBe(
      "https://app.example/v1",
    );
    rows.app = { llmBaseUrl: "https://app-2.example/v1", updatedAt: "" };
    invalidateSettingsCache();
    expect((await withTenant("acme", () => getLlmChannelConfig())).baseUrl).toBe(
      "https://app-2.example/v1",
    );
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
      useCases.update("acme", { a2aApiKey: "asa_x", publicBaseUrl: "https://x" }, "admin@x.com"),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(useCases.update("acme", { a2aApiKey: "asa_x" }, "admin@x.com")).rejects.toThrow(/a2aApiKey/);
  });

  it("refuses to give the default workspace a second row of its own", async () => {
    await expect(useCases.update("default", { llmBaseUrl: "https://x" }, "admin@x.com")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("workspace writes", () => {
  it("stores a secret encrypted and reads it back masked", async () => {
    const view = await useCases.update("acme", { llmApiKey: "sk-workspace-secret" }, "admin@x.com");
    expect(rows.tenants.get("acme")?.llmApiKey).not.toBe("sk-workspace-secret");
    expect(view.fields.llmApiKey?.value).not.toContain("workspace");
    expect(view.fields.llmApiKey?.source).toBe("workspace");
  });

  it("keeps the stored secret when the mask is echoed back", async () => {
    await useCases.update("acme", { llmApiKey: "sk-workspace-secret" }, "admin@x.com");
    const stored = rows.tenants.get("acme")?.llmApiKey;
    const masked = secretCipher.mask(stored!);
    await useCases.update("acme", { llmApiKey: masked }, "admin@x.com");
    expect(rows.tenants.get("acme")?.llmApiKey).toBe(stored);
  });

  it("clears an override with an empty value, falling back to the app layer", async () => {
    rows.app = { llmBaseUrl: "https://app.example/v1", updatedAt: "2026-01-01T00:00:00Z" };
    await useCases.update("acme", { llmBaseUrl: "https://acme.example/v1" }, "admin@x.com");
    await useCases.update("acme", { llmBaseUrl: "" }, "admin@x.com");
    invalidateSettingsCache();
    expect(await withTenant("acme", async () => (await getLlmChannelConfig()).baseUrl)).toBe(
      "https://app.example/v1",
    );
  });

  it("reports every overridable key, inherited until the workspace decides it", async () => {
    const view = await useCases.getView("acme");
    const reported = new Set([...Object.keys(view.fields), "llmProviders"]);
    for (const key of TENANT_OVERRIDABLE_KEYS) {
      expect(reported.has(key)).toBe(true);
    }
    expect(view.fields.llmBaseUrl?.source).toBe("inherited");
    expect(view.llmProviders.source).toBe("inherited");
  });

  it("shows the providers it stored, so they can be seen and cleared", async () => {
    // A key a workspace can set and cannot see is one it cannot undo: the page
    // would show it inheriting the deployment's providers while it overrode
    // them, and clearing needs an empty array the UI has no reason to send.
    const set = await useCases.update(
      "acme",
      { llmProviders: [{ name: "openai", baseUrl: "https://acme.example/v1", apiKey: "sk-a" }] },
      "admin@x.com",
    );
    expect(set.llmProviders.source).toBe("workspace");
    expect(set.llmProviders.items[0]?.baseUrl).toBe("https://acme.example/v1");
    expect(set.llmProviders.items[0]?.apiKey).not.toContain("sk-a");

    const cleared = await useCases.update("acme", { llmProviders: [] }, "admin@x.com");
    expect(cleared.llmProviders).toEqual({ source: "inherited", items: [] });
  });

  it("keeps a provider's stored key when its mask is echoed back", async () => {
    await useCases.update(
      "acme",
      { llmProviders: [{ name: "openai", baseUrl: "https://a.example/v1", apiKey: "sk-a" }] },
      "admin@x.com",
    );
    const storedKey = rows.tenants.get("acme")?.llmProviders?.[0]?.apiKey;
    const view = await useCases.update(
      "acme",
      {
        llmProviders: [
          { name: "openai", baseUrl: "https://b.example/v1", apiKey: secretCipher.mask(storedKey!) },
        ],
      },
      "admin@x.com",
    );
    expect(rows.tenants.get("acme")?.llmProviders?.[0]?.apiKey).toBe(storedKey);
    expect(view.llmProviders.items[0]?.baseUrl).toBe("https://b.example/v1");
  });

  it("treats as a secret exactly what the app settings path does", async () => {
    // Derived from one list rather than kept in step by hand: a credential
    // missed here is stored in plaintext and read back unmasked.
    const view = await useCases.getView("acme");
    for (const key of ["llmApiKey", "githubToken"] as const) {
      expect(view.fields[key]?.secret).toBe(true);
    }
    expect(view.fields.llmBaseUrl?.secret).toBe(false);
  });

  it("records who wrote it, and which keys — never the values", async () => {
    const events: AuditEventInput[] = [];
    setAuditSink(async (event) => {
      events.push(event);
    });
    await useCases.update("acme", { llmApiKey: "sk-secret", llmBaseUrl: "https://x" }, "her@x.com");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "settings.update",
      actorEmail: "her@x.com",
      target: "settings:workspace:acme",
      detail: "keys: llmApiKey, llmBaseUrl",
    });
    expect(JSON.stringify(events[0])).not.toContain("sk-secret");
  });
});
