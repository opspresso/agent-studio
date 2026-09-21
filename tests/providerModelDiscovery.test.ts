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
