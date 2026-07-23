import { describe, expect, it } from "vitest";
import { collectRun } from "@/app/api/projects/_lib/openai";
import type { EngineChunk } from "@/domain/llm/types";

async function* stream(chunks: EngineChunk[]): AsyncGenerator<EngineChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

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
