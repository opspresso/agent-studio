import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageChannel } from "@/infrastructure/llm/imageChannel";
import { resolveProviderTarget } from "@/infrastructure/llm/providers";

/**
 * The image adapter had no test at all, which is how four separate defects
 * against xAI shipped together: a `size` field its API refuses outright, a
 * `response_format` default this adapter cannot read, a hardcoded `image/png`
 * over JPEG bytes, and an edit call sent as multipart to an endpoint that takes
 * JSON only. Every fake `ImageChannel` in the suite sits *above* this module, so
 * none of it was observable. Same harness as `channelAdapter.test.ts`: stub
 * `fetch` and read the outbound request — the OpenAI SDK goes through `fetch`
 * too, so both dialects are checked the same way.
 */

/**
 * The OpenAI base url is per-test on purpose, exactly as `channelAdapter.test.ts`
 * does it: the adapter caches one SDK client per `baseUrl|apiKey`, and a cached
 * client holds the `fetch` that was global when it was built — so a second test
 * reusing the url would silently answer from the first test's stub.
 */
const runtime = { openaiBaseUrl: "https://openai.example/v1" };

const channel = createImageChannel(async (modelId) =>
  resolveProviderTarget(
    modelId,
    [
      { name: "xai", baseUrl: "https://xai.example/v1", apiKey: "xai-key", keepModelPrefix: false },
      {
        name: "openai",
        baseUrl: runtime.openaiBaseUrl,
        apiKey: "openai-key",
        keepModelPrefix: false,
      },
    ],
    { baseUrl: "https://router.example/v1", apiKey: "router-key" },
  ),
);

interface Sent {
  url: string;
  contentType: string | null;
  authorization: string | null;
  /**
   * The body's constructor name. This, not the header, is how multipart is
   * detected: `fetch` derives `Content-Type` (with its boundary) from a
   * `FormData` body at send time, so the header is absent from what the stub
   * observes.
   */
  bodyKind: string;
  raw: string;
}

/** Capture one outbound request and answer with `payload`. */
function stubFetch(payload: unknown, init?: { status?: number }): { sent: Sent | undefined } {
  const box: { sent: Sent | undefined } = { sent: undefined };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, request?: RequestInit) => {
      const source = input instanceof Request ? input.headers : request?.headers;
      const headers = source instanceof Headers ? source : new Headers(source ?? {});
      box.sent = {
        url: input instanceof Request ? input.url : String(input),
        contentType: headers.get("content-type"),
        authorization: headers.get("authorization"),
        bodyKind: request?.body?.constructor?.name ?? "none",
        raw:
          typeof request?.body === "string"
            ? request.body
            : input instanceof Request
              ? await input.clone().text()
              : "",
      };
      return init?.status && init.status >= 400
        ? new Response(JSON.stringify(payload), { status: init.status })
        : Response.json(payload);
    }),
  );
  return box;
}

function body(sent: Sent | undefined): Record<string, unknown> {
  return JSON.parse(sent?.raw ?? "{}") as Record<string, unknown>;
}

const XAI_OK = {
  data: [{ b64_json: "aW1n", mime_type: "image/jpeg" }],
  usage: { cost_in_usd_ticks: 200000000 },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("xAI image dialect", () => {
  it("translates size to aspect_ratio, drops quality, and asks for bytes", async () => {
    const box = stubFetch(XAI_OK);

    const result = await channel.generateImage({
      model: "xai/grok-imagine-image",
      prompt: "a cat",
      size: "1024x1536",
      quality: "high",
    });

    expect(box.sent?.url).toBe("https://xai.example/v1/images/generations");
    expect(box.sent?.authorization).toBe("Bearer xai-key");
    const sent = body(box.sent);
    expect(sent).toMatchObject({
      model: "grok-imagine-image",
      prompt: "a cat",
      aspect_ratio: "2:3",
      resolution: "1k",
      // Without this xAI answers a URL, and the adapter has no bytes to return.
      response_format: "b64_json",
    });
    // The two fields xAI rejects outright — it does not ignore unknown arguments.
    expect(sent).not.toHaveProperty("size");
    expect(sent).not.toHaveProperty("quality");
    // The mime type is the provider's, not an assumption.
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.b64).toBe("aW1n");
  });

  it.each([
    ["1024x1024", "1:1"],
    ["1536x1024", "3:2"],
    ["1024x1536", "2:3"],
  ])("maps the tool schema's %s to %s", async (size, aspectRatio) => {
    const box = stubFetch(XAI_OK);

    await channel.generateImage({ model: "xai/grok-imagine-image", prompt: "x", size });

    expect(body(box.sent)).toMatchObject({ aspect_ratio: aspectRatio, resolution: "1k" });
  });

  it("sends no dimensions rather than a guess for a size it does not know", async () => {
    const box = stubFetch(XAI_OK);

    await channel.generateImage({ model: "xai/grok-imagine-image", prompt: "x", size: "auto" });

    const sent = body(box.sent);
    expect(sent).not.toHaveProperty("aspect_ratio");
    expect(sent).not.toHaveProperty("resolution");
  });

  it("edits over JSON with the image as a data url, never multipart", async () => {
    const box = stubFetch(XAI_OK);

    await channel.editImage({
      model: "xai/grok-imagine-image-quality",
      prompt: "make it night",
      images: [{ b64: "c3Jj", mimeType: "image/png" }],
    });

    expect(box.sent?.url).toBe("https://xai.example/v1/images/edits");
    // xAI documents the SDK's multipart edit call as unsupported.
    expect(box.sent?.contentType).toBe("application/json");
    expect(body(box.sent)).toMatchObject({
      model: "grok-imagine-image-quality",
      image: { url: "data:image/png;base64,c3Jj" },
      response_format: "b64_json",
    });
  });

  it("carries several sources as `images`, which is a different field", async () => {
    const box = stubFetch(XAI_OK);

    await channel.editImage({
      model: "xai/grok-imagine-image-quality",
      prompt: "combine",
      images: [
        { b64: "b25l", mimeType: "image/png" },
        { b64: "dHdv", mimeType: "image/jpeg" },
      ],
    });

    const sent = body(box.sent);
    expect(sent).toMatchObject({
      images: [{ url: "data:image/png;base64,b25l" }, { url: "data:image/jpeg;base64,dHdv" }],
    });
    // The two are mutually exclusive in xAI's schema.
    expect(sent).not.toHaveProperty("image");
  });

  it("refuses a mask instead of redrawing the whole picture and reporting success", async () => {
    stubFetch(XAI_OK);

    await expect(
      channel.editImage({
        model: "xai/grok-imagine-image-quality",
        prompt: "patch",
        images: [{ b64: "c3Jj", mimeType: "image/png" }],
        mask: { b64: "bXNr", mimeType: "image/png" },
      }),
    ).rejects.toThrow(/mask/i);
  });

  it("surfaces the provider's own message on a refusal", async () => {
    stubFetch({ code: "400", error: "Argument not supported: size" }, { status: 400 });

    await expect(
      channel.generateImage({ model: "xai/grok-imagine-image", prompt: "x" }),
    ).rejects.toThrow("400 Argument not supported: size");
  });

  // The shape a model xAI's Images endpoint does not host comes back as, which
  // is the one an operator actually meets. Read as raw JSON it told a reader
  // nothing; the sentence inside it tells them everything.
  it("unwraps the gateway's nested error rather than dumping the body", async () => {
    stubFetch(
      { error: { code: 404, message: "The requested resource was not found." } },
      { status: 404 },
    );

    await expect(
      channel.generateImage({ model: "xai/grok-imagine-image", prompt: "x" }),
    ).rejects.toThrow("404 The requested resource was not found.");
  });

  it("keeps the raw body when it is neither shape", async () => {
    stubFetch({ unexpected: true }, { status: 503 });

    await expect(
      channel.generateImage({ model: "xai/grok-imagine-image", prompt: "x" }),
    ).rejects.toThrow('503 {"unexpected":true}');
  });
});

describe("the OpenAI dialect is unchanged", () => {
  it("still sends size and quality, and no xAI fields", async () => {
    const box = stubFetch({
      data: [{ b64_json: "aW1n" }],
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        input_tokens_details: { text_tokens: 8, image_tokens: 2 },
      },
    });

    const result = await channel.generateImage({
      model: "openai/gpt-image-2",
      prompt: "a cat",
      size: "1024x1536",
      quality: "high",
    });

    expect(box.sent?.url).toBe("https://openai.example/v1/images/generations");
    const sent = body(box.sent);
    expect(sent).toMatchObject({ model: "gpt-image-2", size: "1024x1536", quality: "high" });
    expect(sent).not.toHaveProperty("aspect_ratio");
    // A response with no mime_type still reads as PNG, which is OpenAI's default.
    expect(result.mimeType).toBe("image/png");
    expect(result.usage).toEqual({
      textInputTokens: 8,
      imageInputTokens: 2,
      imageOutputTokens: 100,
    });
  });

  it("still uploads edit sources as multipart", async () => {
    runtime.openaiBaseUrl = "https://openai-edit.example/v1";
    const box = stubFetch({ data: [{ b64_json: "ZWRpdA==" }] });

    await channel.editImage({
      model: "openai/gpt-image-2",
      prompt: "make it night",
      images: [{ b64: "c3Jj", mimeType: "image/png" }],
    });

    expect(box.sent?.url).toBe("https://openai-edit.example/v1/images/edits");
    expect(box.sent?.bodyKind).toBe("FormData");
  });
});
