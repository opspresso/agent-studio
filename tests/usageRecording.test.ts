import { describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import type { EngineDeps } from "@/application/runtime";
import { runAgent } from "@/application/runtime";
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

describe("cached prompt tokens", () => {
  it("records what the provider served from its cache, and omits it when there is none", async () => {
    // Pricing already reads `cached_tokens`; nothing kept it afterwards, so a
    // system prompt that stopped being cacheable cost more per turn while
    // tokens, calls and the answer all looked exactly as they had.
    const recorded: Array<Record<string, unknown>> = [];
    const record = async (r: Record<string, unknown>) => {
      recorded.push(r);
    };

    const cached = new FakeChannel([[contentChunk("hi"), usageChunk(100, 10, 80)]]);
    const withCache = await collect(
      runAgent(
        { channel: cached, recordUsage: record },
        { projectName: "p", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] },
      ),
    );
    expect(recorded[0]).toMatchObject({ inputTokens: 100, cachedTokens: 80 });
    expect(withCache.find((chunk) => chunk.usage)?.usage).toMatchObject({ inputTokens: 100, cachedTokens: 80 });

    recorded.length = 0;
    const silent = new FakeChannel([[contentChunk("hi"), usageChunk(100, 10)]]);
    const withoutCache = await collect(
      runAgent(
        { channel: silent, recordUsage: record },
        { projectName: "p", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] },
      ),
    );
    expect(recorded[0]).not.toHaveProperty("cachedTokens");
    expect(withoutCache.find((chunk) => chunk.usage)?.usage).not.toHaveProperty("cachedTokens");
  });
});

describe("Agent usage recording is best-effort", () => {
  it("runAgent ends with done and no error frame when recordUsage throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = new FakeChannel([[contentChunk("hello"), usageChunk(1, 1)]]);
    const chunks = await collect(
      runAgent(
        { channel, recordUsage: failingUsage },
        { projectName: "p", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hi" }] },
      ),
    );
    expect(chunks.some((c) => c.error)).toBe(false);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.map((c) => c.delta?.content ?? "").join("")).toBe("hello");
    spy.mockRestore();
  });
});
