import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTranscriptionTarget, invalidateSettingsCache } from "@/lib/runtime-settings";
import { fixtureRegistrations } from "./modelFixtures";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { calculateTranscriptionCost, getModelConfig } from "@/domain/llm/models";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({ settingsRepository: { get: vi.fn(async () => null) } }));
beforeEach(() => { invalidateSettingsCache(); vi.mocked(settingsRepository.get).mockResolvedValue({ registeredModels: fixtureRegistrations(), updatedAt: "" }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("transcription model configuration", () => {
  it("uses an explicitly registered keyless self-hosted ASR connection", async () => {
    vi.mocked(settingsRepository.get).mockResolvedValue({
      registeredModels: [{ ...fixtureRegistrations().find(model => model.id === "openai/whisper-1")!, id: "local/whisper-1", provider: "local" }],
      llmProviders: [{ name: "local", kind: "selfhosted", baseUrl: "http://asr.test/v1", apiKey: "" }], updatedAt: "",
    });
    const target = await getTranscriptionTarget("local/whisper-1");
    expect(target).toMatchObject({ baseUrl: "http://asr.test/v1", wireId: "whisper-1", apiKey: "not-required" });
  });

  it("uses a declared provider channel when a dedicated ASR endpoint is absent", async () => {
    vi.stubEnv("TRANSCRIPTION_BASE_URL", ""); vi.stubEnv("TRANSCRIPTION_API_KEY", "");
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "http://provider.test/v1");
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "provider-key");
    expect(await getTranscriptionTarget("openai/whisper-1")).toMatchObject({ baseUrl: "http://provider.test/v1", apiKey: "provider-key" });
  });

  it("refuses a text model or missing ASR channel", async () => {
    vi.stubEnv("TRANSCRIPTION_BASE_URL", ""); vi.stubEnv("TRANSCRIPTION_API_KEY", "");
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "");
    await expect(getTranscriptionTarget("openai/whisper-1")).rejects.toThrow("not a registered transcription");
    await expect(getTranscriptionTarget("openai/gpt-5-mini")).rejects.toThrow("not a registered transcription");
  });

  it("validates transcription response format independently of legacy endpoint settings", async () => {
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "http://provider.test/v1");
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "provider-key");
    vi.stubEnv("TRANSCRIPTION_RESPONSE_FORMAT", "xml");
    await expect(getTranscriptionTarget("openai/whisper-1")).rejects.toThrow("RESPONSE_FORMAT");
  });
});

describe("transcription cost units", () => {
  it("prices duration-based models by reported seconds", () => {
    const price = getModelConfig("openai/whisper-1")!.pricing.perAudioMinute!;
    expect(calculateTranscriptionCost("openai/whisper-1", { audioSeconds: 90 })).toBe(price * 1.5);
    expect(calculateTranscriptionCost("openai/whisper-1")).toBeUndefined();
  });
  it("prices token-based models without inventing missing token counts", () => {
    const id = "openai/gpt-4o-mini-transcribe";
    const price = getModelConfig(id)!.pricing;
    expect(calculateTranscriptionCost(id, { inputTokens: 100, outputTokens: 30 }))
      .toBe((100 * price.inputPer1M + 30 * price.outputPer1M) / 1_000_000);
    expect(calculateTranscriptionCost(id, { inputTokens: 100 })).toBeUndefined();
    expect(calculateTranscriptionCost("unknown", { audioSeconds: 60 })).toBeUndefined();
  });
});
