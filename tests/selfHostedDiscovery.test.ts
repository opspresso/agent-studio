import { describe, expect, it, vi } from "vitest";
import {
  listServedSelfHostedChannels,
  listServedSelfHostedModels,
  selfHostedDiscoveryChannels,
} from "@/infrastructure/llm/selfHostedDiscovery";

const CHANNEL = { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "dummy" };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("listServedSelfHostedModels", () => {
  it("excludes retrieval fallbacks backed by public provider channels", () => {
    const providers = [
      {
        name: "selfhosted",
        baseUrl: "http://models.internal/v1",
        apiKey: "local",
        auth: "bearer" as const,
        keepModelPrefix: false,
      },
      {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1/",
        apiKey: "public",
        auth: "bearer" as const,
        keepModelPrefix: true,
      },
    ];

    expect(
      selfHostedDiscoveryChannels(providers, {
        defaultBaseUrl: "https://default-router.example/v1",
        embedding: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "public" },
        reranker: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "public" },
      }),
    ).toEqual([
      { channel: providers[0], type: "text" },
    ]);
  });

  it("keeps distinct deployment-owned retrieval endpoints and deduplicates shared ones", () => {
    expect(
      selfHostedDiscoveryChannels([], {
        defaultBaseUrl: "https://default-router.example/v1",
        embedding: { baseUrl: "http://embedding.internal/v1/", apiKey: "" },
        reranker: { baseUrl: "http://embedding.internal/v1", apiKey: "" },
      }),
    ).toEqual([
      {
        channel: { baseUrl: "http://embedding.internal/v1/", apiKey: "" },
        type: "embedding",
      },
    ]);
  });

  it("merges LM Studio's native facts and types its embedding models", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === "http://127.0.0.1:1234/v1/models") {
        return json({
          data: [{ id: "google/gemma-4-e4b" }, { id: "qwen/qwen3.8-27b" }, { id: "embed-x" }],
        });
      }
      if (u === "http://127.0.0.1:1234/api/v0/models") {
        return json({
          data: [
            { id: "google/gemma-4-e4b", max_context_length: 131072, type: "vlm" },
            { id: "embed-x", type: "embeddings" },
          ],
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(listServedSelfHostedModels(CHANNEL, "text", fetchFn)).resolves.toEqual([
      { name: "google/gemma-4-e4b", type: "text", contextWindow: 131072, vision: true },
      { name: "qwen/qwen3.8-27b", type: "text" },
      { name: "embed-x", type: "embedding" },
    ]);
    // The channel listing is read with the channel's own credential.
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Authorization).toBe("Bearer dummy");
  });

  it("works without the native catalog and reads vLLM's max_model_len", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/models")
        ? json({ data: [{ id: "qwen3-8b", max_model_len: 32768 }] })
        : new Response("", { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(listServedSelfHostedModels(CHANNEL, "rerank", fetchFn)).resolves.toEqual([
      { name: "qwen3-8b", type: "rerank", contextWindow: 32768 },
    ]);
  });

  it("raises a channel that does not answer", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("", { status: 503, statusText: "Unavailable" }),
    ) as unknown as typeof fetch;

    await expect(listServedSelfHostedModels(CHANNEL, "text", fetchFn)).rejects.toThrow(/503 Unavailable/);
  });

  it("keeps healthy models visible when another endpoint is down", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value === "http://llm.test/v1/models") {
        return json({ data: [{ id: "qwen-text", max_model_len: 32768 }] });
      }
      if (value === "http://embedding.test/v1/models") {
        return new Response("", { status: 503, statusText: "Unavailable" });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      listServedSelfHostedChannels(
        [
          { channel: { baseUrl: "http://llm.test/v1", apiKey: "" }, type: "text" },
          { channel: { baseUrl: "http://embedding.test/v1", apiKey: "" }, type: "embedding" },
        ],
        fetchFn,
      ),
    ).resolves.toEqual({
      served: [{ name: "qwen-text", type: "text", contextWindow: 32768 }],
      servedError: "embedding: GET http://embedding.test/v1/models → 503 Unavailable",
    });
  });
});
