/**
 * The Bedrock adapter's one real hazard: pairing a vector back to its text.
 *
 * Titan has no batch form, so a reindex is one request per entry and the
 * adapter fans them out in waves. A vector written to the wrong slot attaches
 * one capability's meaning to another's name — and every vector involved is
 * valid, so nothing errors and the only symptom is a ranking that is quietly
 * wrong.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

interface SentBody {
  inputText: string;
  dimensions?: number;
  normalize?: boolean;
}
const sent: SentBody[] = [];

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: class {
    async send(command: { input: { body: string } }) {
      const body = JSON.parse(command.input.body) as SentBody;
      sent.push(body);
      // The vector encodes its own input, so a mis-paired result is visible.
      return {
        body: new TextEncoder().encode(JSON.stringify({ embedding: [body.inputText.length] })),
      };
    }
  },
  InvokeModelCommand: class {
    constructor(public input: { body: string; modelId: string }) {}
  },
}));

const { bedrockEmbeddings } = await import("@/infrastructure/llm/bedrockEmbeddings");

afterEach(() => {
  sent.length = 0;
});

describe("bedrockEmbeddings", () => {
  it("keeps vectors aligned with their texts across concurrency waves", async () => {
    // More texts than one wave holds, so the offset arithmetic is exercised
    // rather than assumed.
    const texts = Array.from({ length: 20 }, (_, index) => "x".repeat(index + 1));
    expect(await bedrockEmbeddings.embed(texts, "document")).toEqual(
      texts.map((text) => [text.length]),
    );
  });

  it("asks for the configured dimension, normalized", async () => {
    // Titan v2 serves several dimensions from one model and the index was built
    // for exactly one; leaving it to a default is how vectors stop fitting.
    // `normalize` is what makes cosine the metric the index was created with
    // rather than something merely proportional to it.
    await bedrockEmbeddings.embed(["hello"], "document");
    expect(sent).toEqual([{ inputText: "hello", dimensions: 1024, normalize: true }]);
  });

  it("refuses a response carrying no embedding", async () => {
    // Better a failed reindex than an index with a hole nothing reports.
    const module = await import("@aws-sdk/client-bedrock-runtime");
    const original = module.BedrockRuntimeClient.prototype.send;
    module.BedrockRuntimeClient.prototype.send = async () => ({
      body: new TextEncoder().encode(JSON.stringify({ message: "throttled" })),
    });
    await expect(bedrockEmbeddings.embed(["a"], "document")).rejects.toThrow("returned no embedding");
    module.BedrockRuntimeClient.prototype.send = original;
  });

  it("makes no request for an empty batch", async () => {
    expect(await bedrockEmbeddings.embed([], "document")).toEqual([]);
    expect(sent).toEqual([]);
  });
});
