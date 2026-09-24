import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRequiredConfig, config } from "@/lib/config";
import { resolveBranding } from "@/shared/branding";
import { GET as favicon } from "@/app/favicon.ico/route";
import { config as proxyConfig } from "@/proxy";
import { getServiceBranding, invalidateSettingsCache } from "@/lib/runtime-settings";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: vi.fn().mockResolvedValue(null) },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(settingsRepository.get).mockResolvedValue(null);
  invalidateSettingsCache();
});

describe("deployment branding", () => {
  it("defaults to Agent Studio and selects AgentOps assets independently of the name", () => {
    expect(resolveBranding()).toMatchObject({
      name: "Agent Studio",
      logo: "agent-studio",
      logoUrl: "/brands/agent-studio/logo.png",
    });
    expect(resolveBranding("My Agents", "agentops")).toMatchObject({
      name: "My Agents",
      logo: "agentops",
      logoUrl: "/brands/agentops/logo.png",
      faviconUrl: "/brands/agentops/favicon.ico",
    });
  });

  it("refuses unsafe folder names and multiline display names", () => {
    expect(() => resolveBranding("Agents", "../agentops")).toThrow("SERVICE_LOGO");
    expect(() => resolveBranding("Agents", "AgentOps")).toThrow("SERVICE_LOGO");
    expect(() => resolveBranding("Agent\nOps", "agentops")).toThrow("SERVICE_NAME");
    expect(() => resolveBranding("A".repeat(81), "agentops")).toThrow("SERVICE_NAME");
  });

  it.each(["agent-studio", "agentops"])("boots with the %s asset set", (logo) => {
    vi.stubEnv("DATABASE_URL", "postgres://unit:unit@localhost:5432/unit");
    vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
    vi.stubEnv("SERVICE_LOGO", logo);
    expect(() => assertRequiredConfig()).not.toThrow();
  });

  it("refuses a missing asset folder at boot", () => {
    vi.stubEnv("DATABASE_URL", "postgres://unit:unit@localhost:5432/unit");
    vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
    vi.stubEnv("SERVICE_LOGO", "missing-brand");
    expect(() => assertRequiredConfig()).toThrow("SERVICE_LOGO=missing-brand requires");
  });

  it("redirects conventional favicon requests to the selected folder without caching", async () => {
    vi.stubEnv("SERVICE_LOGO", "agentops");
    expect(config.branding.name).toBe("Agent Studio");
    const response = await favicon();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/brands/agentops/favicon.ico");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses saved branding over deployment values for pages and the favicon", async () => {
    vi.stubEnv("SERVICE_NAME", "Environment Name");
    vi.stubEnv("SERVICE_LOGO", "agent-studio");
    vi.mocked(settingsRepository.get).mockResolvedValue({
      updatedAt: "2026-09-24T00:00:00Z", serviceName: "Saved Name", serviceLogo: "agentops",
    });
    invalidateSettingsCache();
    await expect(getServiceBranding()).resolves.toMatchObject({ name: "Saved Name", logo: "agentops" });
    expect((await favicon()).headers.get("location")).toBe("/brands/agentops/favicon.ico");
  });

  it("lets branding assets through the page gate without opening similar page paths", () => {
    const matches = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matches.test("/brands/agentops/logo.png")).toBe(false);
    expect(matches.test("/favicon.ico")).toBe(false);
    expect(matches.test("/faviconXico")).toBe(true);
    expect(matches.test("/agents")).toBe(true);
  });
});
