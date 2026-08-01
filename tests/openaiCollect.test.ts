import { describe, expect, it } from "vitest";
import { toChatCompletion, toChatCompletionChunks } from "@/app/api/projects/_lib/openai";
import { collectRun } from "@/application/execution/runProject";
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

  it("streams an image a subagent drew", async () => {
    // Delegating to an image subagent is how an agent project draws, so the
    // picture arrives authored — it is still the answer.
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(
      stream([
        { author: "simple-image", image: { b64: "Ynll", mimeType: "image/png" } },
        { delta: { content: "here it is" } },
        { done: true },
      ]),
      "m",
    )) {
      frames.push(frame);
    }

    const deltas = frames.map((f) => (f.choices as Array<{ delta: unknown }>)[0]?.delta);
    expect(deltas[0]).toEqual({
      role: "assistant",
      images: [{ b64: "Ynll", mimeType: "image/png" }],
    });
    expect(deltas[1]).toEqual({ content: "here it is" });
  });
});

describe("authored error chunks", () => {
  it("does not fail the stream when a subagent reports an error", async () => {
    // The engine hands a failed transfer to the parent as a tool error and the
    // parent still answers; only a top-level error fails the request.
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(
      stream([
        { author: "child", error: "remote agent cannot take images" },
        { delta: { content: "did it locally" } },
        { done: true },
      ]),
      "m",
    )) {
      frames.push(frame);
    }
    expect(finishReasons(frames)).toEqual(["stop"]);
  });

  it("still fails the stream on a top-level error", async () => {
    await expect(async () => {
      for await (const _frame of toChatCompletionChunks(stream([{ error: "boom" }]), "m")) {
        void _frame;
      }
    }).rejects.toThrow("boom");
  });

  it("collects the answer past a subagent error", async () => {
    const result = await collectRun(
      stream([
        { author: "child", error: "transfer refused" },
        { delta: { content: "answered anyway" } },
        { done: true },
      ]),
      "m",
    );
    expect(result.content).toBe("answered anyway");
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

  it("reports length when the turn guard announced the run's ending", async () => {
    // The guard says so explicitly now; `length` is read from the announced
    // reason, never inferred from the absence of `done`.
    const frames = await collectFrames([
      { delta: { content: "partial" } },
      { warning: "The run stopped at its turn limit (2 turns) before the model finished answering." },
      { finishReason: "turn-limit" },
    ]);
    expect(finishReasons(frames)).toEqual(["length"]);
  });

  it("fails a stream that ends without announcing a termination", async () => {
    // The inference this used to make ("no done → length") reported a
    // cancellation and a mid-stream error as a length stop. An unannounced
    // ending is a defect, not a length stop.
    await expect(async () => {
      for await (const _frame of toChatCompletionChunks(
        stream([{ delta: { content: "partial" } }]),
        "m",
      )) {
        void _frame;
      }
    }).rejects.toThrow("without announcing a termination");
  });

  it("does not read a child's termination as the stream's", async () => {
    // A child that hit its own turn limit is absorbed into the parent's tool
    // result; only the top-level termination speaks for the stream.
    const frames = await collectFrames([
      { author: "child", finishReason: "turn-limit" },
      { delta: { content: "answered anyway" } },
      { done: true },
    ]);
    expect(finishReasons(frames)).toEqual(["stop"]);
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

describe("collected termination", () => {
  it("reports length on a collected run the turn guard ended", async () => {
    const result = await collectRun(
      stream([{ delta: { content: "partial" } }, { finishReason: "turn-limit" }]),
      "m",
    );
    expect(result.termination).toBe("turn-limit");
    const completion = toChatCompletion(result);
    expect((completion.choices as Array<{ finish_reason: unknown }>)[0]?.finish_reason).toBe(
      "length",
    );
  });

  it("reports stop on a collected run that completed", async () => {
    const result = await collectRun(
      stream([{ delta: { content: "full answer" } }, { done: true }]),
      "m",
    );
    expect(result.termination).toBe("completed");
    const completion = toChatCompletion(result);
    expect((completion.choices as Array<{ finish_reason: unknown }>)[0]?.finish_reason).toBe(
      "stop",
    );
  });
});
