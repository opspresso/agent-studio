import { describe, expect, it } from "vitest";
import { createTestModel } from "@/application/llm/testModel";
import { ValidationError } from "@/application/errors";
import type { LlmChannel } from "@/domain/llm/channel";
import { FakeChannel } from "./fakeChannel";

const KNOWN_MODEL = "openai/gpt-5.4";

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
});
