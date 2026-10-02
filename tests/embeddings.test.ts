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

import { fixtureRegistrations } from "./modelFixtures";
import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { openAiEmbeddings } from "@/infrastructure/llm/embeddings";
import { invalidateSettingsCache } from "@/lib/runtime-settings";
import { encryptSecret } from "@/infrastructure/crypto/secretEncryption";

function respondWith(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ));
}

// Distinct endpoints isolate each test's SDK client cache and provider settings.
const entropy = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomBytes: (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++entropy.sequence);
    return bytes;
  },
}));
let address = 0;
beforeEach(() => {
  entropy.sequence = 0;
  vi.useFakeTimers();
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
  vi.stubEnv("AES_ENCRYPTION_KEY", Buffer.alloc(32, 3).toString("base64"));
  vi.stubEnv("EMBEDDING_BASE_URL", undefined);
  vi.stubEnv("EMBEDDING_API_KEY", undefined);
  vi.stubEnv("EMBEDDING_DIM", undefined);
  invalidateSettingsCache();
  address += 1;
  vi.mocked(settingsRepository.get).mockResolvedValue({
    registeredModels: fixtureRegistrations(),
    embeddingModel: "openai/text-embedding-3-small",
    llmProviders: [{ name: "openai", baseUrl: `https://router-${address}.example/v1`, apiKey: encryptSecret("router-key") }],
    updatedAt: "2026-01-01T00:00:00Z",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invalidateSettingsCache();
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
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.redirect).toBe("error");
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

  it.each([[0, 0], [0, 2], [-1, 0], [0, 0.5], ["0", 1], [null, 1]])(
    "refuses invalid batch indexes %j, %j",
    async (first, second) => {
      respondWith({
        data: [
          { index: first, embedding: [0.1] },
          { index: second, embedding: [0.2] },
        ],
      });
      await expect(openAiEmbeddings.embed(["one", "two"], "document")).rejects.toThrow(
        "Embedding response indexes must cover each input exactly once",
      );
    },
  );

  it("asks for the width the index was created at, not the model's default", async () => {
    // `text-embedding-3-small` is natively 1536 while every instruction for
    // creating the index says 1024, so the documented default configuration
    // produced vectors the index rejected — visible only in a background log.
    let sent: unknown;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await openAiEmbeddings.embed(["one"], "document");
    expect(sent).toMatchObject({ dimensions: 1024, encoding_format: "float" });
  });

  it("omits dimensions when the model requires its native width", async () => {
    vi.stubEnv("EMBEDDING_DIM", "native");
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await openAiEmbeddings.embed(["one"], "document");
    expect(sent).toMatchObject({ encoding_format: "float" });
    expect(sent).not.toHaveProperty("dimensions");
  });

  it("ignores legacy embedding endpoints and uses the selected provider", async () => {
    vi.stubEnv("EMBEDDING_BASE_URL", `https://embedding-${address}.example/v1`);
    let request: { url?: string; authorization?: string | null } = {};
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      request = {
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      };
      return new Response(
        JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1] }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await openAiEmbeddings.embed(["one"], "document");
    expect(request.url).toBe(`https://router-${address}.example/v1/embeddings`);
    expect(request.authorization).toBe("Bearer router-key");
  });

  it("makes no request at all for an empty batch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await openAiEmbeddings.embed([], "document")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes a public model through its provider even with a self-hosted embedding endpoint", async () => {
    vi.stubEnv("EMBEDDING_BASE_URL", "http://spark.test:8001/v1");
    vi.mocked(settingsRepository.get).mockResolvedValue({
      registeredModels: fixtureRegistrations(),
      embeddingModel: "openrouter/text-embedding-3-small",
      llmProviders: [{
        name: "openrouter",
        baseUrl: `https://provider-${address}.example/v1`,
        apiKey: encryptSecret("provider-key"),
      }],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [0.1] }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);

    await openAiEmbeddings.embed(["one"], "document");

    const [url, init] = (fetchSpy.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(String(url)).toBe(`https://provider-${address}.example/v1/embeddings`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer provider-key");
    expect(JSON.parse(String(init.body)).model).toBe("openai/text-embedding-3-small");
  });
});
