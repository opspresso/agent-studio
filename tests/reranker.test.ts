import { afterEach, describe, expect, it, vi } from "vitest";
import { createReranker } from "@/infrastructure/llm/reranker";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createReranker", () => {
  it("returns scores in document order and sends the configured model", async () => {
    let request: { url?: string; body?: unknown; authorization?: string | null } = {};
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      request = {
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      return new Response(
        JSON.stringify({
          usage: { prompt_tokens: 42, total_tokens: 42 },
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const reranker = createReranker(() => ({
      baseUrl: "http://spark.test:8002/v1/",
      apiKey: "reranker-key",
      id: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
      wireId: "Qwen/Qwen3-Reranker-0.6B",
    }));

    await expect(
      reranker.rerank("query", ["first", "second"], "Find useful capabilities"),
    ).resolves.toEqual({
      scores: [0.2, 0.9],
      usage: {
        model: "selfhosted/Qwen/Qwen3-Reranker-0.6B",
        inputTokens: 42,
        costUsd: 0,
      },
    });
    expect(request).toEqual({
      url: "http://spark.test:8002/v1/rerank",
      authorization: "Bearer reranker-key",
      body: {
        model: "Qwen/Qwen3-Reranker-0.6B",
        query: "query",
        documents: ["first", "second"],
        top_n: 2,
        instruction: "Find useful capabilities",
      },
    });
  });

  it("refuses a response that cannot be paired with every document", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.2 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const reranker = createReranker(() => ({
      baseUrl: "http://spark.test/v1",
      id: "selfhosted/reranker",
      wireId: "reranker",
    }));
    await expect(reranker.rerank("query", ["first", "second"])).rejects.toThrow(
      "returned 1 scores for 2 documents",
    );
  });

  it("reads OpenRouter total tokens for token-priced rerank usage", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          usage: { total_tokens: 150, search_units: 1 },
          results: [{ index: 0, relevance_score: 0.8 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const reranker = createReranker(() => ({
      baseUrl: "https://openrouter.ai/api/v1",
      id: "openrouter/rerank-2.5",
      wireId: "voyageai/rerank-2.5",
    }));

    await expect(reranker.rerank("query", ["document"])).resolves.toMatchObject({
      usage: {
        model: "openrouter/rerank-2.5",
        inputTokens: 150,
        costUsd: 0.0000075,
      },
    });
  });

  it("makes no request for an empty document list", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reranker = createReranker(() => ({
      baseUrl: "http://spark.test/v1",
      id: "selfhosted/reranker",
      wireId: "reranker",
    }));
    await expect(reranker.rerank("query", [])).resolves.toEqual({ scores: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([-0.1, 1.1])("refuses a score outside the activation range: %s", async (score) => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: score }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const reranker = createReranker(() => ({
      baseUrl: "http://spark.test/v1",
      id: "selfhosted/reranker",
      wireId: "reranker",
    }));
    await expect(reranker.rerank("query", ["document"])).rejects.toThrow(
      "returned an invalid result",
    );
  });

  it("propagates caller cancellation while resolving the runtime model", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reranker = createReranker(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    const pending = reranker.rerank("query", ["document"], undefined, controller.signal);
    controller.abort(new Error("Stop pressed"));

    await expect(pending).rejects.toThrow("Stop pressed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves endpoint, credential and model together after a selection changes", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.8 }],
    })));
    vi.stubGlobal("fetch", fetchSpy);
    let target = {
      baseUrl: "http://spark.test:8002/v1", apiKey: "spark-key",
      id: "selfhosted/reranker", wireId: "reranker",
    };
    const reranker = createReranker(async () => target);
    await reranker.rerank("query", ["document"]);
    target = {
      baseUrl: "https://router.test/api/v1", apiKey: "router-key",
      id: "openrouter/rerank-2.5", wireId: "voyageai/rerank-2.5",
    };
    await reranker.rerank("query", ["document"]);

    const calls = fetchSpy.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "http://spark.test:8002/v1/rerank", "https://router.test/api/v1/rerank",
    ]);
    expect(new Headers(calls[1]![1].headers).get("authorization")).toBe("Bearer router-key");
    expect(JSON.parse(String(calls[1]![1].body)).model).toBe("voyageai/rerank-2.5");
  });
});
