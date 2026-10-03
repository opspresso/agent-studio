import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const fetchMock = vi.fn<typeof globalThis.fetch>();
let readyGet: typeof import("@/app/api/ready/route")["GET"];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-03T00:00:00Z");
  vi.stubEnv("S3_BUCKET_NAME", undefined);
  vi.stubEnv("CATALOG_ENABLED", "false");
  vi.stubEnv("MANAGED_MCP_RUNTIME", undefined);
  vi.stubEnv("MANAGED_MCP_REGISTRY", undefined);
  store.rows.clear();
  fetchMock.mockReset().mockRejectedValue(new Error("Public network unavailable"));
  vi.stubGlobal("fetch", fetchMock);
  // Compose outside the timed request assertion, as the running app does at boot.
  ({ GET: readyGet } = await import("@/app/api/ready/route"));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

it("keeps the real readiness route available without contacting a configured external model", async () => {
  store.seed([{ ...keys.settings(), entityType: "SETTINGS", updatedAt: "2026-10-03T00:00:00Z",
    defaultModel: "external/model",
    llmProviders: [{ name: "external", kind: "openai", baseUrl: "https://unreachable.example/v1", apiKey: "synthetic-key" }],
    registeredModels: [{ id: "external/model", provider: "external", wireId: "model", displayName: "External model", type: "text",
      contextWindow: 10000, maxTokens: 1000, capabilities: { tools: true, structuredOutput: false, imageInput: false, reasoning: false } }],
  }]);
  const settings = await import("@/lib/runtime-settings");
  settings.invalidateSettingsCache();
  expect(await settings.getDefaultModel()).toBe("external/model");
  const response = await readyGet();
  expect(await response.json()).toEqual({ ready: true, checks: { db: "ok" } });
  expect(response.status).toBe(200);
  expect(fetchMock).not.toHaveBeenCalled();
});
