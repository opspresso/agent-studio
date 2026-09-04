import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestModel } from "@/application/llm/testModel";
import { ValidationError } from "@/application/errors";
import type { LlmChannel } from "@/domain/llm/channel";
import { FakeChannel } from "./fakeChannel";
import { loadSelfHostedModels } from "@/domain/llm/models";

const KNOWN_MODEL = "openai/gpt-5.4";

afterEach(() => {
  loadSelfHostedModels([]);
});

function failingChannel(message: string): LlmChannel {
  return {
    async chatCompletion() {
      throw new Error(message);
    },
    async *chatCompletionStream() {
      throw new Error(message);
    },
  };
}

describe("createTestModel", () => {
  it("reports ok on a returned completion, even one with no content", async () => {
    // An empty script yields `content: null` — a reasoning model that spent the
    // whole budget on hidden reasoning looks exactly like this, and it still
    // proves the model answers here.
    const channel = new FakeChannel([[]]);

    const result = await createTestModel(channel)(KNOWN_MODEL);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends one tiny bounded completion for the model under test", async () => {
    const channel = new FakeChannel([[]]);

    await createTestModel(channel)(KNOWN_MODEL);

    expect(channel.seenParams).toHaveLength(1);
    expect(channel.seenParams[0]).toMatchObject({
      model: KNOWN_MODEL,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    expect(channel.seenParams[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a channel failure as a result, not an exception", async () => {
    const result = await createTestModel(failingChannel("upstream said 401"))(KNOWN_MODEL);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("upstream said 401");
  });

  it("rejects an id the registry does not carry before touching the channel", async () => {
    const channel = new FakeChannel([[]]);

    await expect(createTestModel(channel)("openai/not-a-model")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(channel.seenParams).toHaveLength(0);
  });

  it("does not send an embedding model to chat completion", async () => {
    const channel = new FakeChannel([[]]);

    await expect(
      createTestModel(channel)("openrouter/text-embedding-3-small"),
    ).rejects.toThrow("Embedding model cannot be tested through chat completion");
    expect(channel.seenParams).toHaveLength(0);
  });

  it("tests a rerank model through the specialized endpoint", async () => {
    const channel = new FakeChannel([[]]);
    const testReranker = vi.fn(async () => {});
    loadSelfHostedModels([
      {
        id: "selfhosted/reranker",
        provider: "selfhosted",
        family: "reranker",
        maker: "local",
        displayName: "Reranker",
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          rerank: true,
        },
        contextWindow: 32768,
        maxTokens: 0,
      },
    ]);
    const result = await createTestModel(channel, { testReranker })("selfhosted/reranker");

    expect(result.ok).toBe(true);
    expect(testReranker).toHaveBeenCalledWith("selfhosted/reranker", expect.any(AbortSignal));
    expect(channel.seenParams).toHaveLength(0);
  });

  it("reports a rerank probe failure as a test result", async () => {
    loadSelfHostedModels([
      {
        id: "selfhosted/reranker",
        provider: "selfhosted",
        family: "reranker",
        maker: "local",
        displayName: "Reranker",
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          rerank: true,
        },
        contextWindow: 32768,
        maxTokens: 0,
      },
    ]);

    const result = await createTestModel(new FakeChannel([[]]), {
      testReranker: async () => {
        throw new Error("semantic probe failed");
      },
    })("selfhosted/reranker");

    expect(result).toMatchObject({ ok: false, error: "semantic probe failed" });
  });

  it("does not send a transcription model to chat completion", async () => {
    const channel = new FakeChannel([[]]);
    loadSelfHostedModels([
      {
        id: "selfhosted/transcriber",
        provider: "selfhosted",
        family: "transcriber",
        maker: "local",
        displayName: "Transcriber",
        pricing: { inputPer1M: 0, outputPer1M: 0 },
        capabilities: {
          tools: false,
          structuredOutput: false,
          imageInput: false,
          reasoning: false,
          transcription: true,
        },
        contextWindow: 0,
        maxTokens: 0,
      },
    ]);
    await expect(createTestModel(channel)("selfhosted/transcriber")).rejects.toThrow(
      "Transcription model cannot be tested through chat completion",
    );
    expect(channel.seenParams).toHaveLength(0);
  });
});
