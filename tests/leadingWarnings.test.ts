import { describe, expect, it } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import { withLeadingWarnings } from "@/application/run/leadingWarnings";

describe("leading warning stream", () => {
  it.each([0, 1, 2])("closes the source when stopped after yield %i", async (index) => {
    let closed = 0;
    async function* source(): AsyncGenerator<EngineChunk> {
      try {
        yield { delta: { content: "first" } };
        yield { delta: { content: "second" } };
      } finally {
        closed += 1;
      }
    }
    const stream = withLeadingWarnings(["attachment unavailable"], source());
    for (let step = 0; step <= index; step += 1) {
      await stream.next();
    }
    await stream.return(undefined);
    expect(closed).toBe(1);
  });

  it("closes after the first chunk when there are no warnings", async () => {
    let closed = false;
    async function* source(): AsyncGenerator<EngineChunk> {
      try {
        yield { delta: { content: "first" } };
      } finally {
        closed = true;
      }
    }
    const stream = withLeadingWarnings([], source());
    await stream.next();
    await stream.return(undefined);
    expect(closed).toBe(true);
  });

  it("preserves a first-pull refusal without emitting warnings", async () => {
    const refusal = new Error("run refused");
    async function* source(): AsyncGenerator<EngineChunk> {
      throw refusal;
    }
    await expect(withLeadingWarnings(["attachment unavailable"], source()).next()).rejects.toBe(refusal);
  });

  it("preserves warning and source order", async () => {
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "first" } };
      yield { delta: { content: "second" } };
    }
    const chunks = [];
    for await (const chunk of withLeadingWarnings(["one", "two"], source())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { warning: "one" },
      { warning: "two" },
      { delta: { content: "first" } },
      { delta: { content: "second" } },
    ]);
  });
});
