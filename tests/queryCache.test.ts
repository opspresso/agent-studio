/**
 * The query-embedding cache.
 *
 * Every run searches with its version's system prompt, which does not change
 * for the life of that version — so the same text is embedded on every run of
 * it, on the critical path before the first token. What this must never do in
 * exchange is hand back a vector belonging to a different text.
 */

import { describe, expect, it, vi } from "vitest";
import { cacheQueryEmbeddings } from "@/application/catalog/queryCache";
import type { EmbeddingPort } from "@/domain/vector/types";

/** Each vector encodes its input, so a mis-paired result is visible. */
function counting(): { port: EmbeddingPort; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    port: {
      embed: async (texts) => {
        calls.push([...texts]);
        return texts.map((text) => [text.length]);
      },
    },
  };
}

describe("cacheQueryEmbeddings", () => {
  it("embeds a repeated query once and answers the rest from memory", async () => {
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port);
    const prompt = "You are a Slack assistant";

    expect(await cached.embed([prompt], "query")).toEqual([[prompt.length]]);
    expect(await cached.embed([prompt], "query")).toEqual([[prompt.length]]);
    expect(inner.calls).toEqual([[prompt]]);
  });

  it("asks only for the texts it does not have, and rebuilds the caller's order", async () => {
    // The real shape: a system prompt that repeats beside a request that never
    // does. Order matters because every caller zips the answer against its
    // input.
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port);
    await cached.embed(["prompt"], "query");
    inner.calls.length = 0;

    expect(await cached.embed(["prompt", "a request"], "query")).toEqual([[6], [9]]);
    expect(inner.calls).toEqual([["a request"]]);
  });

  it("does not cache documents", async () => {
    // A reindex sees each text once; caching them evicts the queries that
    // repeat and holds the catalog in memory to do it.
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port);
    await cached.embed(["entry"], "document");
    await cached.embed(["entry"], "document");
    expect(inner.calls).toEqual([["entry"], ["entry"]]);
  });

  it("collapses a duplicate inside one batch", async () => {
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port);
    expect(await cached.embed(["same", "same"], "query")).toEqual([[4], [4]]);
    expect(inner.calls).toEqual([["same"]]);
  });

  it("evicts the oldest once it is full, keeping what is still being asked for", async () => {
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port, 2);
    await cached.embed(["prompt"], "query");
    await cached.embed(["req-1"], "query");
    // Re-asking moves `prompt` to the end, so `req-1` is the oldest.
    await cached.embed(["prompt"], "query");
    await cached.embed(["req-2"], "query");
    inner.calls.length = 0;

    await cached.embed(["prompt", "req-1"], "query");
    expect(inner.calls).toEqual([["req-1"]]);
  });

  it("falls back to a plain call when the inner port answers short", async () => {
    // Zipping a short answer would pair vectors with the wrong texts — the one
    // corruption this file exists to prevent.
    const inner: EmbeddingPort = { embed: vi.fn(async () => [[1]]) };
    const cached = cacheQueryEmbeddings(inner);
    expect(await cached.embed(["a", "b"], "query")).toEqual([[1]]);
    expect(inner.embed).toHaveBeenCalledTimes(2);
  });
});
