import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTranscriptionTarget, invalidateSettingsCache } from "@/lib/runtime-settings";
import { fixtureRegistrations } from "./modelFixtures";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { calculateTranscriptionCost, getModelConfig } from "@/domain/llm/models";
import { config } from "@/lib/config";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({ settingsRepository: { get: vi.fn(async () => null) } }));
beforeEach(() => { invalidateSettingsCache(); vi.mocked(settingsRepository.get).mockResolvedValue({ registeredModels: fixtureRegistrations(), updatedAt: "" }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("transcription model configuration", () => {
  it("applies protocol overrides only to the selected registered model", async () => {
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "http://provider.test/v1");
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "provider-key");
    vi.stubEnv("TRANSCRIPTION_MODEL_OPTIONS", JSON.stringify({ "openai/whisper-1": {
      responseFormat: "verbose_json", preferOriginal: true, segmentSeconds: 600,
      providerOptions: { azure: { diarization: { enabled: true } } },
    } }));
    expect(await getTranscriptionTarget("openai/whisper-1")).toMatchObject({ responseFormat: "verbose_json",
      preferOriginal: true, segmentSeconds: 600, providerOptions: { azure: { diarization: { enabled: true } } } });
    expect(config.transcription.responseFormat).toBe("json");
  });
  it.each(['[]', '{"model":{"baseUrl":"http://unapproved.test"}}', '{"model":{"segmentSeconds":0}}'])
    ("rejects invalid model protocol configuration without printing values: %s", value => {
      vi.stubEnv("TRANSCRIPTION_MODEL_OPTIONS", value);
      expect(() => config.transcription).toThrow("Invalid TRANSCRIPTION_MODEL_OPTIONS");
    });
  it("requires a private token and immutable revision when whole-recording diarization is enabled", () => {
    vi.stubEnv("DIARIZATION_BASE_URL", "http://diarization.test");
    vi.stubEnv("DIARIZATION_TOKEN", ""); vi.stubEnv("DIARIZATION_REVISION", "");
    expect(() => config.transcription).toThrow("requires DIARIZATION_TOKEN and DIARIZATION_REVISION");
    vi.stubEnv("DIARIZATION_TOKEN", "synthetic-token"); vi.stubEnv("DIARIZATION_REVISION", "v1");
    expect(config.transcription.diarization).toEqual({ baseUrl: "http://diarization.test", token: "synthetic-token", revision: "v1" });
  });
  it("uses an explicitly registered keyless self-hosted ASR connection", async () => {
    vi.mocked(settingsRepository.get).mockResolvedValue({
      registeredModels: [{ ...fixtureRegistrations().find(model => model.id === "openai/whisper-1")!, id: "local/whisper-1", provider: "local" }],
      llmProviders: [{ name: "local", kind: "selfhosted", baseUrl: "http://asr.test/v1", apiKey: "" }], updatedAt: "",
    });
    const target = await getTranscriptionTarget("local/whisper-1");
    expect(target).toMatchObject({ baseUrl: "http://asr.test/v1", wireId: "whisper-1", apiKey: "not-required" });
  });

  it("uses the selected transcription model provider connection", async () => {
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "http://provider.test/v1");
    vi.stubEnv("LLM_PROVIDER_OPENAI_API_KEY", "provider-key");
    expect(await getTranscriptionTarget("openai/whisper-1")).toMatchObject({ baseUrl: "http://provider.test/v1", apiKey: "provider-key" });
  });

  it("refuses a text model or missing ASR channel", async () => {
    vi.stubEnv("LLM_PROVIDER_OPENAI_BASE_URL", "");
    await expect(getTranscriptionTarget("openai/whisper-1")).rejects.toThrow("not a registered transcription");
    await expect(getTranscriptionTarget("openai/gpt-5-mini")).rejects.toThrow("not a registered transcription");
  });

  it("validates the transcription response format", async () => {
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
