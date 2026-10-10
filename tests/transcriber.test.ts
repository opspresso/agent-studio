import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriber, type TranscriptionConfig } from "@/infrastructure/llm/transcription";

const config: TranscriptionConfig = {
  baseUrl: "http://asr.test/v1/", apiKey: "test-only-key", id: "selfhosted/asr",
  wireId: "asr-wire", maxInputBytes: 1024,
};
const input = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg", filename: "audio.mp3" };
function respond(body: unknown) {
  return vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
}
beforeEach(() => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenAI-compatible transcription adapter", () => {
  it("preserves measured request time separately from unknown output tokens", async () => {
    let now = 0;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn(async () => {
      now += 800;
      return Response.json({ text: "hello", usage: { seconds: 10 } });
    }));
    const result = await createTranscriber(config).transcribe(input);
    expect(result.modelDurationMs).toBe(800);
    expect(result.usage).toEqual({ audioSeconds: 10 });
  });
  it.each([{ start: -0.01, end: 1 }, { start: 0 }, { end: 1 }, { start: "unknown", end: 1 }])("keeps labelled segments and usage when optional word timestamps are invalid: %j", async (timing) => {
    const segments = [{ text: "Complete phrase.", start: 0, end: 2, speaker: "A" }];
    respond({ text: "Complete phrase.", segments, words: [{ word: "Complete", speaker: "A", ...timing }], usage: { seconds: 2 } });
    const result = await createTranscriber(config).transcribe(input);
    expect(result).toMatchObject({ text: "Complete phrase.", segments, usage: { audioSeconds: 2 } });
    expect(result.warnings).toContain("Transcription provider returned invalid word timestamps; those timestamps were omitted while preserving text and speaker labels.");
  });
  it("keeps word-only text and labels when timestamps are missing", async () => {
    respond({ text: "Hello there", words: [{ word: "Hello", speaker: 0 }, { word: "there", speaker: 1, start: -1, end: 1 }], usage: { seconds: 2 } });
    const result = await createTranscriber(config).transcribe(input);
    expect(result.segments).toEqual([{ text: "Hello", speaker: "0" }, { text: "there", speaker: "1" }]);
    expect(result.text).toBe("Hello there");
    expect(result.usage).toEqual({ audioSeconds: 2 });
  });
  it("sends provider-native options as JSON and derives segments from numeric word speakers", async () => {
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.input_audio).toEqual({ data: "AQID", format: "mp3" });
      expect(body.provider).toEqual({ options: { "google-ai-studio": { diarization_mode: "speaker" } } });
      expect(body.response_format).toBe("verbose_json");
      return Response.json({ text: "안녕 하세요. 네.", segments: [{ text: "안녕 하세요. 네.", start: 0, end: 3 }], words: [
        { word: "안녕", start: 0, end: 1, speaker: 0 }, { word: "하세요.", start: 1, end: 2, speaker: 0 },
        { word: "네.", start: 2, end: 3, speaker: 1 },
      ], usage: { input_tokens: 7, output_tokens: 0 } });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await createTranscriber({ ...config, responseFormat: "verbose_json",
      providerOptions: { "google-ai-studio": { diarization_mode: "speaker" } } }).transcribe(input);
    expect(result.segments).toEqual([{ text: "안녕 하세요.", start: 0, end: 2, speaker: "0" },
      { text: "네.", start: 2, end: 3, speaker: "1" }]);
    expect(result.text).toBe("안녕 하세요. 네.");
    expect(new Headers(fetcher.mock.calls[0]![1].headers).get("content-type")).toBe("application/json");
  });
  it("preserves complete provider phrase text and numeric labels when words are also supplied", async () => {
    respond({ text: "Hello, there.", segments: [{ text: "Hello, there.", start: 0, end: 2, speaker: 0 }],
      words: [{ word: "Hello", start: 0, end: 1, speaker: 0 }, { word: "there", start: 1, end: 2, speaker: 0 }] });
    expect((await createTranscriber(config).transcribe(input)).segments).toEqual([
      { text: "Hello, there.", start: 0, end: 2, speaker: "0" },
    ]);
  });
  it("reports invalid word timing without dropping utterances, speaker labels or billing usage", async () => {
    respond({ text: "A B C", words: [
      { word: "A", start: 0, end: 1, speaker: 0 },
      { word: "B", start: 2, end: 1.5, speaker: 0 },
      { word: "C", start: 3, end: 4, speaker: 0 },
    ], usage: { input_tokens: 10, output_tokens: 0 } });
    const result = await createTranscriber(config).transcribe(input);
    expect(result.segments).toEqual([{ text: "A", start: 0, end: 1, speaker: "0" },
      { text: "B", speaker: "0" }, { text: "C", start: 3, end: 4, speaker: "0" }]);
    expect(result.text).toBe("A B C");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(result.warnings).toEqual(["Transcription provider returned invalid word timestamps; those timestamps were omitted while preserving text and speaker labels."]);
  });
  it("sends binary multipart audio and the deployment wire model without following redirects", async () => {
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("model")).toBe("asr-wire");
      expect(form.get("response_format")).toBe("json");
      expect(form.get("language")).toBe("ko");
      const file = form.get("file") as File;
      expect(file.name).toBe("audio.mp3");
      expect(file.type).toBe("audio/mpeg");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(input.bytes);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-only-key");
      expect(new Headers(init.headers).has("content-type")).toBe(false);
      expect(init.redirect).toBe("error");
      return Response.json({ text: "안녕하세요", usage: { type: "tokens", input_tokens: 7, output_tokens: 3 } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(createTranscriber(config).transcribe({ ...input, language: "ko" })).resolves.toEqual({
      text: "안녕하세요", segments: [], model: "selfhosted/asr", warnings: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://asr.test/v1/audio/transcriptions");
  });

  it("preserves diarized timing and duration usage with explicit provider options", async () => {
    const segments = [{ text: "hello", start: 0, end: 1.25, speaker: "A" }];
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect((init.body as FormData).get("chunking_strategy")).toBe("auto");
      expect((init.body as FormData).get("response_format")).toBe("diarized_json");
      return Response.json({ text: "hello", segments, usage: { type: "duration", seconds: 2 } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(createTranscriber({ ...config, responseFormat: "diarized_json", chunkingStrategy: "auto" })
      .transcribe(input)).resolves.toMatchObject({ segments, usage: { audioSeconds: 2 } });
  });

  it("does not treat the media duration as reported billing usage", async () => {
    respond({ text: "", duration: 4 });
    const result = await createTranscriber(config).transcribe(input);
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    {}, { text: 4 }, { text: "a", segments: [null] },
    { text: "a", segments: [{ text: "a", start: 2, end: 1 }] },
    { text: "a", usage: { input_tokens: -1 } }, { text: "a", model: "unexpected-model" },
  ])("refuses an invalid response without exposing its contents: %j", async (body) => {
    respond(body);
    await expect(createTranscriber(config).transcribe(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([400, 401, 403, 413, 429, 500])("reports HTTP %i without leaking provider error bodies", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private transcript and token", { status })));
    await expect(createTranscriber(config).transcribe(input)).rejects.toMatchObject({
      message: `Transcription provider returned HTTP ${status}`,
      code: status === 401 || status === 403 ? "authentication"
        : status >= 500 || status === 429 ? "unavailable" : "unsupported",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds a declared oversized provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-length": String(11 * 1024 * 1024) },
    })));
    await expect(createTranscriber(config).transcribe(input)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { bytes: new Uint8Array() }, { bytes: new Uint8Array(1025) },
    { filename: "../audio.mp3" }, { mimeType: "text/plain" }, { language: "korean" },
  ])("rejects invalid input before sending: %j", async (override) => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createTranscriber(config).transcribe({ ...input, ...override }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation without retry", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {
      controller.abort(new Error("job cancelled"));
      init.signal?.throwIfAborted();
    }));
    await expect(createTranscriber(config).transcribe(input, controller.signal)).rejects.toThrow("job cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("hides endpoint details on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret URL query")));
    await expect(createTranscriber(config).transcribe(input)).rejects.toThrow("Transcription request failed");
  });

  it("does not submit already cancelled work", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createTranscriber(config).transcribe(input, AbortSignal.abort(new Error("cancelled"))))
      .rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates the request timeout through the provider signal", async () => {
    const deadline = new AbortController();
    vi.mocked(AbortSignal.timeout).mockReturnValue(deadline.signal);
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      init.signal?.throwIfAborted();
    }));
    await expect(createTranscriber(config).transcribe(input)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(600_000);
  });

  it("rejects malformed JSON without exposing source text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private transcript")));
    await expect(createTranscriber(config).transcribe(input)).rejects.toMatchObject({
      message: "Transcription response is unreadable or exceeds the size limit",
    });
  });
});
