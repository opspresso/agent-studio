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
    const result = await collectRun(
      stream([{ delta: { content: "text only" } }, { done: true }]),
      "m",
    );
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

/**
 * A file a tool produced, on the surfaces that answer with one.
 *
 * The bytes are gone by the time a surface sees the chunk — the bracket stored
 * them and stripped the payload — so what travels is a reference, and what a
 * caller receives is an address. Both OpenAI shapes carry it, because a run
 * that renders a report and answers "here is your report" with no report was
 * this endpoint's behaviour until they did.
 */
describe("a file a run produced, on the OpenAI surface", () => {
  const rendered: EngineChunk = {
    file: {
      name: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "mcp: render_document",
      byteSize: 2048,
      key: "objects/report.docx",
      artifactId: "art-1",
    },
  };

  it("collects the reference, provenance stripped, from a child's turn too", async () => {
    const result = await collectRun(
      stream([
        { delta: { content: "done" } },
        rendered,
        { author: "writer", file: { name: "notes.pdf", mimeType: "application/pdf", source: "mcp: x", key: "objects/notes.pdf" } },
        { done: true },
      ]),
      "m",
    );
    // What a reader needs, and nothing that only the platform does: `source` and
    // `artifactId` name the run's own bookkeeping.
    expect(result.files).toEqual([
      {
        fileId: "art-1",
        name: "report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        byteSize: 2048,
        key: "objects/report.docx",
      },
      { name: "notes.pdf", mimeType: "application/pdf", key: "objects/notes.pdf" },
    ]);
  });

  it("omits the files field when a run produced none", async () => {
    const result = await collectRun(stream([{ delta: { content: "text" } }, { done: true }]), "m");
    expect(result.files).toEqual([]);
    expect(toChatCompletion(result)).not.toHaveProperty("files");
  });

  it("carries addressed files as an extension on the collected completion", async () => {
    const result = await collectRun(stream([rendered, { done: true }]), "m");
    const completion = toChatCompletion({
      ...result,
      files: [{ name: "report.docx", mimeType: "application/msword", url: "https://signed/report" }],
    });
    expect(completion.files).toEqual([
      { name: "report.docx", mimeType: "application/msword", url: "https://signed/report" },
    ]);
  });

  it("streams an addressed file as a delta extension without a terminal frame", async () => {
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(stream([rendered, { done: true }]), "m", async (ref) => ({
      file: { name: ref.name, mimeType: ref.mimeType, url: `https://signed/${ref.key}` },
    }))) {
      frames.push(frame);
    }
    const deltas = frames.map((f) => (f.choices as Array<{ delta: unknown }>)[0]?.delta);
    expect(deltas[0]).toEqual({
      role: "assistant",
      files: [
        {
          name: "report.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          url: "https://signed/objects/report.docx",
        },
      ],
    });
    expect(finishReasons(frames)).toEqual(["stop"]);
  });

  it("streams the reason instead when the file has no address", async () => {
    // Silence here is the bug this replaces: the run produced something and the
    // caller has to be able to tell that from a run that produced nothing.
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(stream([rendered, { done: true }]), "m", async () => ({
      warning: "1 file(s) this run produced were not kept.",
    }))) {
      frames.push(frame);
    }
    const deltas = frames.map((f) => (f.choices as Array<{ delta: unknown }>)[0]?.delta);
    expect(deltas[0]).toEqual({
      role: "assistant",
      warnings: ["1 file(s) this run produced were not kept."],
    });
  });

  it("says nothing about files when the surface supplied no resolver", async () => {
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(stream([rendered, { done: true }]), "m")) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(1);
    expect(finishReasons(frames)).toEqual(["stop"]);
  });
});

/**
 * The OpenAI schema has no field for what a run lost, which is the same problem
 * `images` has — so it takes the same answer. The two shapes have to agree:
 * `finish_reason` is here because they once did not.
 */
describe("what a run lost, on the OpenAI surface", () => {
  it("carries warnings as an extension on the collected completion", async () => {
    const result = await collectRun(
      stream([
        { warning: "Skill 'gone' is no longer in the registry; it was not offered." },
        { delta: { content: "answered anyway" } },
        { done: true },
      ]),
      "m",
    );

    expect(toChatCompletion(result).warnings).toEqual([
      "Skill 'gone' is no longer in the registry; it was not offered.",
    ]);
  });

  it("omits the field when a run lost nothing", async () => {
    const result = await collectRun(stream([{ delta: { content: "clean" } }, { done: true }]), "m");

    expect(result.warnings).toEqual([]);
    expect(toChatCompletion(result)).not.toHaveProperty("warnings");
  });

  it("streams a warning as a delta extension without a terminal frame", async () => {
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(
      stream([
        { warning: "MCP server 'gone' was blocked" },
        { author: "child", warning: "Subagent 'child' stopped at its turn limit" },
        { delta: { content: "answered" } },
        { done: true },
      ]),
      "m",
    )) {
      frames.push(frame);
    }

    const deltas = frames.map((f) => (f.choices as Array<{ delta: unknown }>)[0]?.delta);
    expect(deltas[0]).toEqual({
      role: "assistant",
      warnings: ["MCP server 'gone' was blocked"],
    });
    // Authored like an image, and for the same reason: a child's warning names
    // its own agent and the loss is the caller's. Only a *termination* is
    // filtered by author.
    expect(deltas[1]).toEqual({
      warnings: ["Subagent 'child' stopped at its turn limit"],
    });
    expect(deltas[2]).toEqual({ content: "answered" });
    expect(finishReasons(frames)).toEqual(["stop"]);
  });
});

describe("authored error chunks", () => {
  it("does not fail the stream when a subagent reports an error", async () => {
    // The engine hands a failed transfer to the parent as a tool error and the
    // parent still answers; only a top-level error fails the request.
    const frames: Record<string, unknown>[] = [];
    for await (const frame of toChatCompletionChunks(
      stream([
        { author: "child", error: "child Agent could not use the image" },
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
    // The inference this would make ("no done → length") reported a
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

  it("reports length when the provider cut the answer at its output cap", async () => {
    const frames = await collectFrames([
      { delta: { content: "partial" } },
      { warning: "The answer was cut at the model's output limit before it finished." },
      { finishReason: "output-limit" },
    ]);
    expect(finishReasons(frames)).toEqual(["length"]);
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

  it("fails a collected run whose stream announced nothing", async () => {
    // The stream path already refuses this; minting a `stop` here kept the
    // same producer defect invisible on the collected surface — which is how
    // an image dispatch that ended its stream bare once shipped unnoticed.
    const result = await collectRun(stream([{ delta: { content: "partial" } }]), "m");
    expect(result.termination).toBeUndefined();
    expect(() => toChatCompletion(result)).toThrow("without announcing a termination");
  });
});
