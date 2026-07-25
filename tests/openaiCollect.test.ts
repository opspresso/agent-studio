import { describe, expect, it } from "vitest";
import {
  collectRun,
  toChatCompletion,
  toChatCompletionChunks,
} from "@/app/api/projects/_lib/openai";
import type { EngineChunk } from "@/domain/llm/types";

async function* stream(chunks: EngineChunk[]): AsyncGenerator<EngineChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const finishReasons = (frames: Record<string, unknown>[]): unknown[] =>
  frames
    .map((frame) => (frame.choices as Array<{ finish_reason: unknown }>)[0]?.finish_reason)
    .filter((reason) => reason !== null);

describe("collectRun", () => {
  it("collects only top-level content but bills subagent usage too", async () => {
    const result = await collectRun(
      stream([
        { delta: { content: "Top " } },
        { author: "child", delta: { content: "nested" } },
        { author: "child", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 } },
        { delta: { content: "answer." } },
        { usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.02 } },
        { done: true },
      ]),
      "m",
    );
    expect(result.content).toBe("Top answer.");
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(6);
    expect(result.usage.costUsd).toBeCloseTo(0.03, 10);
  });
});

describe("collectRun images", () => {
  it("returns generated images alongside the answer", async () => {
    const result = await collectRun(
      stream([
        { delta: { content: "here you go" } },
        { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } },
        { author: "painter", image: { b64: "Ynll", mimeType: "image/png" } },
        { done: true },
      ]),
      "m",
    );
    expect(result.images).toEqual([
      { b64: "aGk=", mimeType: "image/png", prompt: "a cat" },
      { b64: "Ynll", mimeType: "image/png" },
    ]);
    expect(toChatCompletion(result).images).toEqual(result.images);
  });

  it("omits the images field when a run produced none", async () => {
    const result = await collectRun(stream([{ delta: { content: "text only" } }]), "m");
    expect(result.images).toEqual([]);
    expect(toChatCompletion(result)).not.toHaveProperty("images");
  });
});

describe("toChatCompletionChunks images", () => {
  it("streams an image as a delta extension without a terminal frame", async () => {
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(
      stream([
        { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } },
        { delta: { content: "drawn" } },
        { done: true },
      ]),
      "m",
    )) {
      frames.push(frame);
    }

    const deltas = frames.map((f) => (f.choices as Array<{ delta: unknown }>)[0]?.delta);
    expect(deltas[0]).toEqual({
      role: "assistant",
      images: [{ b64: "aGk=", mimeType: "image/png", prompt: "a cat" }],
    });
    expect(deltas[1]).toEqual({ content: "drawn" });
    expect(finishReasons(frames)).toEqual(["stop"]);
  });
});

describe("toChatCompletionChunks finish_reason", () => {
  async function collectFrames(chunks: EngineChunk[]): Promise<Record<string, unknown>[]> {
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(stream(chunks), "m")) {
      frames.push(frame);
    }
    return frames;
  }

  it("reports stop when the model finished on its own", async () => {
    const frames = await collectFrames([{ delta: { content: "hi" } }, { done: true }]);
    expect(finishReasons(frames)).toEqual(["stop"]);
  });

  it("reports length when the agent loop ended at its turn guard (no done chunk)", async () => {
    // engine.runAgent returns without `done` when the turn budget runs out; an
    // OpenAI client would otherwise see the stream just cut off.
    const frames = await collectFrames([{ delta: { content: "partial" } }]);
    expect(finishReasons(frames)).toEqual(["length"]);
  });

  it("emits exactly one terminal frame", async () => {
    const frames = await collectFrames([
      { delta: { content: "a" } },
      { author: "child", delta: { content: "nested" } },
      { done: true },
    ]);
    expect(finishReasons(frames)).toHaveLength(1);
  });
});
