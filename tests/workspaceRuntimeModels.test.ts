import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRegistrations } from "./modelFixtures";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { createWorkspaceRuntimeModelUseCases } from "@/application/workspace/runtimeModels";
import { getVisibleModels } from "@/domain/llm/models";
import type { ProviderChannelConfig } from "@/domain/settings/types";
import { getWorkspaceRuntimeConfig, invalidateSettingsCache } from "@/lib/runtime-settings";
import { projectHasWorkspaceTools } from "@/domain/project/workspaceAccess";
import type { AgentConfiguration } from "@/domain/project/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-15T08:00:00Z");
const openai = getVisibleModels().find(model => model.provider === "openai" && model.capabilities.tools && !model.hidden)!;
const anthropic = getVisibleModels().find(model => model.provider === "anthropic" && model.capabilities.tools && !model.hidden)!;
let channels: ProviderChannelConfig[];
const api = createWorkspaceRuntimeModelUseCases({ repository: settingsRepository, channels: async () => channels, invalidate: invalidateSettingsCache, now: () => now });
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear(); invalidateSettingsCache();
  await settingsRepository.update(() => ({ registeredModels: fixtureRegistrations(), updatedAt: "" }));
  channels = [{ name: "openai", baseUrl: "http://localhost:9999/v1", apiKey: "test-key", auth: "bearer", keepModelPrefix: false }];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); invalidateSettingsCache(); });

describe("Workspace runtime model selection", () => {
  it("starts with only command and rejects incompatible, hidden and unconfigured models", async () => {
    expect(await api.getView()).toMatchObject({ selections: {}, available: ["command"] });
    await expect(api.select("claude", openai.id, "admin@test")).rejects.toMatchObject({ status: 400 });
    await expect(api.select("claude", anthropic.id, "admin@test")).rejects.toMatchObject({ status: 400 });
    channels = [];
    await expect(api.select("codex", openai.id, "admin@test")).rejects.toMatchObject({ status: 400 });
    expect((await settingsRepository.get())?.workspaceModels).toBeUndefined();
  });
  it("preserves unrelated settings and concurrent runtime selections, without returning credentials", async () => {
    await settingsRepository.update(() => ({ embeddingModel: "embedding-preserved", registeredModels: fixtureRegistrations(), updatedAt: now.toISOString() }));
    await Promise.all([api.select("codex", openai.id, "admin@test"), api.select("opencode", openai.id, "admin@test")]);
    expect(await settingsRepository.get()).toMatchObject({ embeddingModel: "embedding-preserved", workspaceModels: { codex: openai.id, opencode: openai.id } });
    expect(JSON.stringify(await api.getView())).not.toContain("test-key");
    await api.select("codex", null, "admin@test");
    expect((await api.getView()).available).toEqual(["command", "opencode"]);
  });
  it("resolves the selected channel only at dispatch and disables execution when credentials disappear", async () => {
    await api.select("codex", openai.id, "admin@test");
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", channels[0]!.baseUrl);
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "test-key");
    vi.stubEnv("LLM_PROVIDER_OPENAI_KEEP_MODEL_PREFIX", "true");
    expect(await getWorkspaceRuntimeConfig("codex")).toMatchObject({ model: openai.id, environment: { CODEX_API_KEY: "test-key", OPENAI_BASE_URL: channels[0]!.baseUrl } });
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "");
    expect(await getWorkspaceRuntimeConfig("codex")).toBeUndefined();
    expect(await getWorkspaceRuntimeConfig("command")).toEqual({});
  });
  it("uses the current Workspace opt-in independently from audio", () => {
    const configuration: AgentConfiguration = { projectName: "p", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false, workspaceTools: true, audioProcessing: false }, mcpList: [], skillList: [], subagentList: [] };
    expect(projectHasWorkspaceTools({ configuration })).toBe(true);
    expect(projectHasWorkspaceTools({ configuration: { ...configuration, parameters: { piiFiltering: false, workspaceTools: false, audioProcessing: true } } })).toBe(false);
    expect(projectHasWorkspaceTools({})).toBe(false);
  });
});
