import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageChannel } from "@/infrastructure/llm/imageChannel";
import { buildImageEditor, buildImageGenerator } from "@/application/execution/imageTool";
import type { UsageCall } from "@/application/usage/recordUsage";

afterEach(() => vi.unstubAllGlobals());

describe("image model throughput", () => {
  it.each(["openai", "openrouter", "xai"])("measures generation and editing for %s", async provider => {
    let now = 0;
    vi.mocked(performance.now).mockImplementation(() => now);
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      // The SDK probes local FormData support with a data URL before its first multipart call.
      if (String(url).startsWith("data:")) return new Response("");
      now += 500;
      return Response.json({ data: [{ b64_json: "aW1n" }], usage: { input_tokens: 10, output_tokens: 100, prompt_tokens: 10, completion_tokens: 100 } });
    }));
    const channel = createImageChannel(async () => {
      now += 2000;
      return { providerName: provider, baseUrl: `https://${provider}.image-timing.test/v1`, apiKey: "test", model: "test-image", auth: "bearer" };
    });
    const params = { model: "test/image", prompt: "image" };
    expect((await channel.generateImage(params)).modelDurationMs).toBe(500);
    expect((await channel.editImage({ ...params, images: [{ b64: "aW1n", mimeType: "image/png" }] })).modelDurationMs).toBe(500);
  });

  it.each([0, 100])("records both image tools with timing only for reported output tokens: %s", async output => {
    const result = { b64: "aW1n", mimeType: "image/png", modelDurationMs: 500,
      usage: { textInputTokens: 10, imageInputTokens: 0, imageOutputTokens: output } };
    const deps = { imageChannel: { generateImage: async () => result, editImage: async () => result } };
    const record = vi.fn(async (_call: UsageCall) => {});
    const generate = buildImageGenerator(deps, "openai/gpt-image-1", "agent", record)!;
    const edit = buildImageEditor(deps, "openai/gpt-image-1", "agent", record)!;
    await generate("image");
    await edit({ prompt: "image", images: [{ b64: "aW1n", mimeType: "image/png" }] });
    expect(record).toHaveBeenCalledTimes(2);
    for (const call of record.mock.calls) {
      if (output) expect(call).toEqual([expect.objectContaining({ modelDurationMs: 500, outputTokens: output })]);
      else expect(call[0]).not.toHaveProperty("modelDurationMs");
    }
  });
});
