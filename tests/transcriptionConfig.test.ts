import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTranscriptionTarget, invalidateSettingsCache } from "@/lib/runtime-settings";
import { calculateTranscriptionCost, getModelConfig } from "@/domain/llm/models";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({ settingsRepository: { get: vi.fn(async () => null) } }));
beforeEach(() => { invalidateSettingsCache(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("transcription model configuration", () => {
  it("uses an explicit ASR endpoint without reusing a text provider credential", async () => {
    vi.stubEnv("TRANSCRIPTION_BASE_URL", "http://asr.test/v1");
    vi.stubEnv("TRANSCRIPTION_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "unrelated-text-key");
    const target = await getTranscriptionTarget("openai/whisper-1");
    expect(target).toMatchObject({ baseUrl: "http://asr.test/v1", wireId: "whisper-1", id: "openai/whisper-1" });
    expect(target.apiKey).toBeUndefined();
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
    await expect(getTranscriptionTarget("openai/whisper-1")).rejects.toThrow("not configured");
    await expect(getTranscriptionTarget("openai/gpt-5-mini")).rejects.toThrow("not a registered transcription");
  });

  it("validates response format and dedicated credential pairing", async () => {
    vi.stubEnv("TRANSCRIPTION_BASE_URL", ""); vi.stubEnv("TRANSCRIPTION_API_KEY", "key");
    await expect(getTranscriptionTarget("openai/whisper-1")).rejects.toThrow("requires");
    vi.stubEnv("TRANSCRIPTION_BASE_URL", "http://asr.test/v1");
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
