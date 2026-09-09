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
