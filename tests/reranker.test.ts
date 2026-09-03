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
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.2 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const reranker = createReranker({
      baseUrl: "http://spark.test:8002/v1/",
      apiKey: "reranker-key",
      model: () => "Qwen/Qwen3-Reranker-0.6B",
    });

    await expect(
      reranker.rerank("query", ["first", "second"], "Find useful capabilities"),
    ).resolves.toEqual([0.2, 0.9]);
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
    const reranker = createReranker({ baseUrl: "http://spark.test/v1", model: () => "reranker" });
    await expect(reranker.rerank("query", ["first", "second"])).rejects.toThrow(
      "returned 1 scores for 2 documents",
    );
  });

  it("makes no request for an empty document list", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const reranker = createReranker({ baseUrl: "http://spark.test/v1", model: () => "reranker" });
    await expect(reranker.rerank("query", [])).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
