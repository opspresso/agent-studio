import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderModelDiscovery } from "@/infrastructure/llm/providerModelDiscovery";
import type { ProviderChannelConfig } from "@/domain/settings/types";

const provider = (name: string, baseUrl = "https://provider.test/v1"): ProviderChannelConfig => ({ name, baseUrl, apiKey: "test-key", auth: "bearer", keepModelPrefix: false });

describe("provider model discovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("classifies OpenAI IDs without inventing prices or context limits", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [
      { id: "gpt-test" }, { id: "gpt-image-test" }, { id: "whisper-test" },
      { id: "text-embedding-test" }, { id: "rerank-test" }, { id: "gpt-realtime-test" }, { id: "unknown" },
    ] }));
    vi.stubGlobal("fetch", fetch);
    const models = await createProviderModelDiscovery().list(provider("openai"));
    expect(models.map((model) => model.type)).toEqual(["text", "image", "transcription", "embedding", "rerank", undefined, undefined]);
    expect(models[0]).toEqual({ wireId: "gpt-test", displayName: "gpt-test", type: "text" });
    expect(fetch).toHaveBeenCalledWith("https://provider.test/v1/models", expect.objectContaining({
      redirect: "error", headers: { accept: "application/json", authorization: "Bearer test-key" },
    }));
  });

  it("reads OpenRouter modalities, capabilities and token rates", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "vendor/example", name: "Example", context_length: 10000,
      top_provider: { max_completion_tokens: 2000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "structured_outputs", "reasoning"],
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
    }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await createProviderModelDiscovery().list(provider("openrouter"))).toEqual([{
      wireId: "vendor/example", displayName: "Example", type: "text", contextWindow: 10000, maxTokens: 2000,
      inputModalities: ["text", "image"], outputModalities: ["text"],
      capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true },
      pricing: { inputPer1M: 1, outputPer1M: 2, cachedInputPer1M: expect.closeTo(0.1) },
    }]);
    expect(fetch.mock.calls[0]?.[0]).toContain("output_modalities=all");
  });

  it("uses Google native listing and consumes every page without putting the key in the URL", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/a", displayName: "A", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 5000, outputTokenLimit: 1000 }], nextPageToken: "page two" }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/b", supportedGenerationMethods: ["embedContent"] }] }));
    vi.stubGlobal("fetch", fetch);
    const result = await createProviderModelDiscovery().list(provider("google", "https://provider.test/v1beta/openai/"));
    expect(result.map((model) => [model.wireId, model.type])).toEqual([["a", "text"], ["b", "embedding"]]);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://provider.test/v1beta/models?pageSize=1000&pageToken=page+two");
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({ accept: "application/json", "x-goog-api-key": "test-key" });
  });

  it("classifies Jev Latest from decisions output and keeps its wire alias, price and limits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest",
      architecture: { modality: "text->decisions", input_modalities: ["text"], output_modalities: ["decisions"] },
      context_length: 32000, top_provider: { max_completion_tokens: 28800 },
      supported_parameters: [], pricing: { prompt: "0.000000042", completion: "0" },
    }] })));
    const [model] = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(model).toEqual({
      wireId: "~typesafe/jev-latest", displayName: "TypeSafe: Jev Latest", type: "decisions",
      inputModalities: ["text"], outputModalities: ["decisions"], contextWindow: 32000, maxTokens: 28800,
      pricing: { inputPer1M: expect.closeTo(0.042), outputPer1M: 0 },
      capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false },
    });
  });

  it("uses declared modalities before model-name guesses for every supported output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [
      ...["decisions", "transcription", "rerank", "embeddings", "image", "text"].map(output => ({ id: `gpt-whisper-${output}`, architecture: { output_modalities: [output] } })),
      { id: "gpt-speech", architecture: { output_modalities: ["speech"] } },
      { id: "gpt-video", architecture: { output_modalities: ["video"] } },
      { id: "opaque-model", architecture: { modality: "text->decisions" } },
    ] })));
    const models = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(models.map(model => model.type)).toEqual(["decisions", "transcription", "rerank", "embedding", "image", "text", undefined, undefined, "decisions"]);
    expect(models[6]?.outputModalities).toEqual(["speech"]);
  });

  it("retains simultaneous text/image outputs and independent tool, vision and reasoning capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "opaque-model", architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
      supported_parameters: ["tools", "structured_outputs", "reasoning"],
    }] })));
    const [model] = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(model).toMatchObject({ type: "image", outputModalities: ["text", "image"], capabilities: { tools: true, imageInput: true, reasoning: true, structuredOutput: true } });
  });

  it("fills missing native-provider facts from exact published wire IDs without enrolling extra models", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "gpt-5.6-sol" }] }));
    vi.stubGlobal("fetch", fetch);
    const result = await createProviderModelDiscovery().list({ ...provider("company"), kind: "openai" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ wireId: "gpt-5.6-sol", type: "text", capabilities: { tools: true, imageInput: true, reasoning: true } });
    expect(result[0]?.pricing?.inputPer1M).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never lets published facts override explicit provider capabilities or prices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "openai/gpt-5.6-sol", name: "Internal allocation", context_length: 2000,
      supported_parameters: [], architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: "0.00001", completion: "0.00002" },
    }] })));
    const [model] = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(model).toMatchObject({ displayName: "Internal allocation", contextWindow: 2000, maxTokens: 2000, pricing: { inputPer1M: 10, outputPer1M: 20 }, capabilities: { tools: false, imageInput: false, reasoning: false, structuredOutput: false } });
  });

  it("drops an inherited cached rate that exceeds the provider's current input price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "openai/gpt-5.6-sol", architecture: { output_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0" },
    }] })));
    const [model] = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(model?.pricing?.inputPer1M).toBe(0);
    expect(model?.pricing?.cachedInputPer1M).toBeUndefined();
  });

  it("preserves image output token rates and does not price unsupported outputs as free", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [
      { id: "vendor/picture", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0", image_output: "0.00003" } },
      { id: "vendor/movie", architecture: { output_modalities: ["video"] }, pricing: { prompt: "0", completion: "0" } },
      { id: "vendor/ranker", architecture: { output_modalities: ["rerank"] }, pricing: { prompt: "0", completion: "0" } },
    ] })));
    const models = await createProviderModelDiscovery().list(provider("openrouter"));
    expect(models[0]?.pricing).toEqual({ inputPer1M: 0, outputPer1M: 0, imageOutputPer1M: 30 });
    expect(models[1]?.pricing).toBeUndefined();
    expect(models[2]?.pricing).toBeUndefined();
  });

  it("uses native Anthropic pagination and a provider kind distinct from its registration name", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-a", display_name: "Claude A", max_input_tokens: 5000, max_tokens: 1000, capabilities: { thinking: { supported: true } } }], has_more: true, last_id: "claude-a" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-b" }], has_more: false }));
    vi.stubGlobal("fetch", fetch);
    const result = await createProviderModelDiscovery().list({ ...provider("company-claude"), kind: "anthropic" });
    expect(result[0]).toMatchObject({ displayName: "Claude A", contextWindow: 5000, maxTokens: 1000, capabilities: { tools: true, reasoning: true } });
    expect(fetch.mock.calls[1]?.[0]).toContain("after_id=claude-a");
    expect(fetch.mock.calls[0]?.[1].headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
  });

  it("supports internal self-hosted URLs and missing authentication", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "local/model", max_model_len: 8000 }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await createProviderModelDiscovery().list({ ...provider("local", "http://localhost:1234/v1"), kind: "selfhosted", apiKey: "" })).toEqual([
      { wireId: "local/model", displayName: "local/model", contextWindow: 8000 },
    ]);
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({ accept: "application/json" });
  });

  it("preserves explicit provider types ahead of name-based hints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [
      { id: "artist", type: "image" }, { id: "image-reader", type: "text" },
    ] })));
    expect((await createProviderModelDiscovery().list(provider("selfhosted"))).map(model => model.type)).toEqual(["image", "text"]);
  });

  it.each(["https://user:secret@provider.test/v1", "https://provider.test/v1?key=secret", "file:///tmp/models", "https://provider.test/#secret"])("rejects unsafe configured URL %s before fetch", async (url) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createProviderModelDiscovery().list(provider("openai", url))).rejects.toThrow("Provider URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose upstream error bodies or connection details", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("echo: test-key", { status: 401 }))
      .mockRejectedValueOnce(new Error("test-key leaked"));
    vi.stubGlobal("fetch", fetch);
    await expect(createProviderModelDiscovery().list(provider("openai"))).rejects.toThrow("Provider model discovery failed (HTTP 401)");
    await expect(createProviderModelDiscovery().list(provider("openai"))).rejects.toThrow("Provider model discovery could not connect");
  });

  it.each([
    [{ unexpected: [] }, "no models array"],
    [{ data: [], has_more: true }, "invalid cursor"],
  ])("rejects incomplete listings", async (body, error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(createProviderModelDiscovery().list(provider("anthropic"))).rejects.toThrow(error);
  });

  it("refuses repeated cursors rather than returning a partial success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" })));
    await expect(createProviderModelDiscovery().list(provider("anthropic"))).rejects.toThrow("repeated a page cursor");
  });

  it("bounds response bytes and does not parse an oversized body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } })));
    await expect(createProviderModelDiscovery().list(provider("openai"))).rejects.toThrow("HTTP body exceeds");
  });
});
