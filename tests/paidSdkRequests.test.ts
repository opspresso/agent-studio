import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageChannel } from "@/infrastructure/llm/imageChannel";
import { openAiEmbeddings } from "@/infrastructure/llm/embeddings";

vi.mock("@/lib/runtime-settings", () => ({
  getEmbeddingModel: async () => "selfhosted/retrieval",
  getEmbeddingTarget: async () => ({ baseUrl: "http://provider.test/v1", apiKey: "fixture-key", model: "retrieval" }),
}));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const images = (operation: string) => createImageChannel(async () => ({
  providerName: "selfhosted", baseUrl: `http://provider.test/${operation}/v1`, apiKey: "fixture-key",
  auth: "bearer", model: "image",
}));

describe("paid SDK requests", () => {
  it.each([
    ["image generation", () => images("generation").generateImage({ model: "selfhosted/image", prompt: "fixture" })],
    ["image editing", () => images("editing").editImage({ model: "selfhosted/image", prompt: "fixture", images: [{ b64: "AQID", mimeType: "image/png" }] })],
    ["query embedding", () => openAiEmbeddings.embed(["fixture"], "query")],
  ] as const)("does not replay %s after an ambiguous provider failure", async (_name, execute) => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
      status: 503, headers: { "content-type": "application/json", "retry-after": "0" },
    }));
    // The SDK's data-URL multipart probe performs no provider request.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "data:," ? Promise.resolve(new Response("")) : fetch(input, init));
    const outcome = execute().then(() => null, error => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
