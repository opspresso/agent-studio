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

/** A fixed embedding space, for the cases that are not about switching one. */
const MODEL = () => "cohere.embed-v4";

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
    const cached = cacheQueryEmbeddings(inner.port, MODEL);
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
    const cached = cacheQueryEmbeddings(inner.port, MODEL);
    await cached.embed(["prompt"], "query");
    inner.calls.length = 0;

    expect(await cached.embed(["prompt", "a request"], "query")).toEqual([[6], [9]]);
    expect(inner.calls).toEqual([["a request"]]);
  });

  it("does not cache documents", async () => {
    // A reindex sees each text once; caching them evicts the queries that
    // repeat and holds the catalog in memory to do it.
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port, MODEL);
    await cached.embed(["entry"], "document");
    await cached.embed(["entry"], "document");
    expect(inner.calls).toEqual([["entry"], ["entry"]]);
  });

  it("collapses a duplicate inside one batch", async () => {
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port, MODEL);
    expect(await cached.embed(["same", "same"], "query")).toEqual([[4], [4]]);
    expect(inner.calls).toEqual([["same"]]);
  });

  it("evicts the oldest once it is full, keeping what is still being asked for", async () => {
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port, MODEL, 2);
    await cached.embed(["prompt"], "query");
    await cached.embed(["req-1"], "query");
    // Re-asking moves `prompt` to the end, so `req-1` is the oldest.
    await cached.embed(["prompt"], "query");
    await cached.embed(["req-2"], "query");
    inner.calls.length = 0;

    await cached.embed(["prompt", "req-1"], "query");
    expect(inner.calls).toEqual([["req-1"]]);
  });

  it("answers every text even when one batch is longer than the whole cache", async () => {
    // A batch past `max` evicts its own earlier entries before the answer is
    // assembled. Reading the result back out of the cache handed those texts
    // `[]` — a vector belonging to no text, which a store accepts and ranks
    // meaninglessly rather than rejecting.
    const inner = counting();
    const cached = cacheQueryEmbeddings(inner.port, MODEL, 2);
    expect(await cached.embed(["aaa", "bbbb", "ccccc"], "query")).toEqual([[3], [4], [5]]);
  });

  it("does not answer with a vector from a different embedding space", async () => {
    // The OpenAI-compatible adapter resolves its endpoint from runtime
    // settings, so an admin can repoint the channel — and rebuild the index —
    // without restarting anything. Answering the new space from vectors of the
    // old one has no symptom at all: the scores are simply wrong.
    const inner = counting();
    let model = "titan-v2";
    const cached = cacheQueryEmbeddings(inner.port, () => model);
    await cached.embed(["prompt"], "query");
    model = "cohere-v4";
    await cached.embed(["prompt"], "query");
    expect(inner.calls).toEqual([["prompt"], ["prompt"]]);
  });

  it("falls back to a plain call when the inner port answers short", async () => {
    // Zipping a short answer would pair vectors with the wrong texts — the one
    // corruption this file exists to prevent.
    const inner: EmbeddingPort = { embed: vi.fn(async () => [[1]]) };
    const cached = cacheQueryEmbeddings(inner, MODEL);
    expect(await cached.embed(["a", "b"], "query")).toEqual([[1]]);
    expect(inner.embed).toHaveBeenCalledTimes(2);
  });
});
