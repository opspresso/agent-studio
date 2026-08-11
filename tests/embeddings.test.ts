process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 3).toString("base64");
process.env.LLM_BASE_URL ??= "https://router.example/v1";
process.env.LLM_API_KEY ??= "router-key";

/**
 * The embedding adapter's one non-obvious job: pairing a vector back to the text
 * it came from.
 *
 * A reindex embeds a batch and zips the answer against the entries it sent, so a
 * response arriving out of order would attach one capability's vector to another
 * one's name — and nothing downstream could tell, because both are valid vectors
 * and the only symptom is a ranking that is quietly wrong. The provider states
 * each item's position for exactly this reason; the adapter has to read it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/db/repositories/settingsRepository", () => ({
  settingsRepository: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
}));

import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { openAiEmbeddings } from "@/infrastructure/llm/embeddings";
import { invalidateSettingsCache } from "@/lib/runtime-settings";

function respondWith(body: unknown): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

// The adapter caches one client per baseUrl|apiKey, and a client binds the
// `fetch` that was global when it was built — so a test reusing an address would
// keep talking to the previous test's stub. A fresh address per test is what
// `channelAdapter.test.ts` does for the same reason.
let address = 0;
beforeEach(() => {
  invalidateSettingsCache();
  address += 1;
  vi.mocked(settingsRepository.get).mockResolvedValue({
    llmBaseUrl: `https://router-${address}.example/v1`,
    updatedAt: "2026-01-01T00:00:00Z",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAiEmbeddings", () => {
  it("returns vectors in the order the texts were given, not the order they arrive", async () => {
    respondWith({
      object: "list",
      model: "text-embedding-3-small",
      data: [
        { object: "embedding", index: 2, embedding: [0.3] },
        { object: "embedding", index: 0, embedding: [0.1] },
        { object: "embedding", index: 1, embedding: [0.2] },
      ],
    });
    expect(await openAiEmbeddings.embed(["first", "second", "third"], "document")).toEqual([
      [0.1],
      [0.2],
      [0.3],
    ]);
  });

  it("refuses a response that answers a different number of inputs", async () => {
    // Silently short would mean the zip pairs everything after the gap with the
    // wrong entry — the same corruption as bad ordering, one index further on.
    respondWith({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1] }],
    });
    await expect(openAiEmbeddings.embed(["one", "two"], "document")).rejects.toThrow(
      "returned 1 vectors for 2 inputs",
    );
  });

  it("makes no request at all for an empty batch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await openAiEmbeddings.embed([], "document")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
