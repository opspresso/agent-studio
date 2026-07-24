import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type { EngineDeps } from "@/application/llm/engine";
import { runPrompt, runPromptStream } from "@/application/llm/engine";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const out: EngineChunk[] = [];
  for await (const chunk of gen) {
    out.push(chunk);
  }
  return out;
}

const failingUsage: EngineDeps["recordUsage"] = async () => {
  throw new Error("dynamo down");
};

describe("single-shot usage recording is best-effort", () => {
  it("runPrompt still returns the generation when recordUsage throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("hello"), usageChunk(1, 1)]]);
    const result = await runPrompt(
      { channel, recordUsage: failingUsage },
      { projectName: "p", model: "openai/gpt-5-mini", userPromptTemplate: "hi" },
    );
    expect(result.content).toBe("hello");
    spy.mockRestore();
  });

  it("runPromptStream ends with done and no error frame when recordUsage throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("hello"), usageChunk(1, 1)]]);
    const chunks = await collect(
      runPromptStream(
        { channel, recordUsage: failingUsage },
        { projectName: "p", model: "openai/gpt-5-mini", userPromptTemplate: "hi" },
      ),
    );
    expect(chunks.some((c) => c.error)).toBe(false);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.map((c) => c.delta?.content ?? "").join("")).toBe("hello");
    spy.mockRestore();
  });
});
