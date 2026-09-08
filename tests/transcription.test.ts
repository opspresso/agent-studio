import { describe, expect, it } from "vitest";
import { TranscriptionError, validateTranscription, type TranscriptionResult } from "@/domain/llm/transcription";

function result(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return { text: "안녕하세요", model: "internal/asr", segments: [], warnings: [], ...overrides };
}

describe("transcription result contract", () => {
  it("preserves text-only output without fabricated speakers, timing or usage", () => {
    expect(validateTranscription(result())).toEqual(result());
    expect(validateTranscription(result()).usage).toBeUndefined();
  });

  it("accepts silence and fractional audio billing without fabricating tokens", () => {
    const value = result({ text: "", usage: { audioSeconds: 0.25 } });
    expect(validateTranscription(value)).toEqual(value);
  });

  it.each([
    { start: 1 },
    { end: 1 },
    { start: -1, end: 2 },
    { start: 3, end: 2 },
    { start: 0, end: Infinity },
    { start: NaN, end: 1 },
  ])("rejects unusable timing %j", (timing) => {
    expect(() => validateTranscription(result({ segments: [{ text: "hello", ...timing }] })))
      .toThrow(TranscriptionError);
  });

  it("preserves overlapping speakers without claiming their identity", () => {
    const value = result({ segments: [
      { text: "a", start: 0, end: 2, speaker: "speaker_1" },
      { text: "b", start: 1, end: 3, speaker: "speaker_2" },
    ] });
    expect(validateTranscription(value)).toEqual(value);
  });

  it.each([
    { inputTokens: -1 }, { inputTokens: 0.5 }, { outputTokens: Infinity },
    { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { audioSeconds: NaN }, { audioSeconds: -1 },
  ])("rejects invalid accounting %j", (usage) => {
    expect(() => validateTranscription(result({ usage }))).toThrow(TranscriptionError);
  });

  it("requires a model identity and meaningful speaker labels", () => {
    expect(() => validateTranscription(result({ model: " " }))).toThrow(TranscriptionError);
    expect(() => validateTranscription(result({ segments: [{ text: "a", speaker: "" }] })))
      .toThrow(TranscriptionError);
  });
});
