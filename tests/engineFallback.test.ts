import { scriptedModels } from "./scriptedModels";
import { describe, expect, it } from "vitest";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  LlmChannel,
} from "./channelFixtures";
import type { EngineChunk } from "@/domain/llm/types";
import { runAgent, type AgentDeps, type RunAgentInput } from "@/application/runtime";
import { contentChunk, usageChunk } from "./fakeChannel";

async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks: EngineChunk[]): string {
  return chunks.map((c) => c.delta?.content ?? "").join("");
}

/** An error carrying an HTTP status, matching what isRetryableError inspects. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

type StreamStep =
  | { kind: "chunks"; chunks: ChannelChunk[] }
  | { kind: "throw"; error: unknown }
  | { kind: "chunksThenThrow"; chunks: ChannelChunk[]; error: unknown };

/** Replays one stream step per successive call; steps may throw. */
class ScriptedChannel implements LlmChannel {
  getModel(name?: string) { return scriptedModels(this).getModel(name); }
  calls = 0;
  readonly seenParams: ChannelParams[] = [];

  constructor(private readonly steps: StreamStep[]) {}

  async chatCompletion(): Promise<ChannelCompletion> {
    throw new Error("chatCompletion is not used in these streaming tests");
  }

  async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
    this.seenParams.push(params);
    const step = this.steps[this.calls++];
    if (!step) {
      return;
    }
    if (step.kind === "throw") {
      throw step.error;
    }
    for (const chunk of step.chunks) {
      yield chunk;
    }
    if (step.kind === "chunksThenThrow") {
      throw step.error;
    }
  }
}

const PRIMARY = "google/gemini-2.5-flash";
const FALLBACK = "openai/gpt-5-mini";

function agentInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    projectName: "fallback-bot",
    model: PRIMARY,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("runAgent streamWithFallback", () => {
  it("retries with the fallback model when the primary fails retryably before the first chunk", async () => {
    const channel = new ScriptedChannel([
      { kind: "throw", error: httpError(429) },
      { kind: "chunks", chunks: [contentChunk("fallback answer"), usageChunk(3, 2)] },
    ]);
    const recorded: Array<{ model: string }> = [];
    const deps: AgentDeps = {
      channel,
      recordUsage: async (r) => {
        recorded.push(r);
      },
    };

    const chunks = await collect(runAgent(deps, agentInput({ fallbackModel: FALLBACK })));

    expect(textOf(chunks)).toBe("fallback answer");
    expect(chunks.some((c) => c.done)).toBe(true);
    expect(chunks.some((c) => c.error)).toBe(false);
    // Second attempt used the fallback model; usage is billed to it.
    expect(channel.seenParams[0]?.model).toBe(PRIMARY);
    expect(channel.seenParams[1]?.model).toBe(FALLBACK);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.model).toBe(FALLBACK);
  });

  it("surfaces a retryable error as an error chunk when no fallback model is configured", async () => {
    const channel = new ScriptedChannel([{ kind: "throw", error: httpError(500) }]);
    const recorded: unknown[] = [];
    const deps: AgentDeps = {
      channel,
      recordUsage: async (r) => {
        recorded.push(r);
      },
    };

    const chunks = await collect(runAgent(deps, agentInput()));

    // No crash: the generator completes, yielding a single error chunk.
    expect(chunks.some((c) => c.error)).toBe(true);
    expect(chunks.some((c) => c.done)).toBe(false);
    expect(channel.calls).toBe(1);
    expect(recorded).toHaveLength(0);
  });

  it("does not retry after chunks have already streamed, yielding an error chunk instead", async () => {
    // A fallback IS configured, but a mid-stream failure must not restart the turn.
    const channel = new ScriptedChannel([
      { kind: "chunksThenThrow", chunks: [contentChunk("partial ")], error: httpError(503) },
      { kind: "chunks", chunks: [contentChunk("SHOULD NOT APPEAR")] },
    ]);
    const deps: AgentDeps = { channel };

    const chunks = await collect(runAgent(deps, agentInput({ fallbackModel: FALLBACK })));

    expect(textOf(chunks)).toBe("partial ");
    expect(chunks.some((c) => c.error)).toBe(true);
    expect(chunks.some((c) => c.done)).toBe(false);
    // The fallback step was never consumed.
    expect(channel.calls).toBe(1);
  });
});

describe("isRetryableError classification via fallback behaviour", () => {
  it.each([429, 500, 502, 503])(
    "treats status %i as retryable and falls back to the fallback model",
    async (status) => {
      const channel = new ScriptedChannel([
        { kind: "throw", error: httpError(status) },
        { kind: "chunks", chunks: [contentChunk("ok"), usageChunk(1, 1)] },
      ]);
      const deps: AgentDeps = { channel };

      const chunks = await collect(runAgent(deps, agentInput({ fallbackModel: FALLBACK })));

      expect(textOf(chunks)).toBe("ok");
      expect(chunks.some((c) => c.error)).toBe(false);
      expect(channel.seenParams[1]?.model).toBe(FALLBACK);
    },
  );

  it.each([400, 401])(
    "treats status %i as non-retryable and surfaces the error without falling back",
    async (status) => {
      const channel = new ScriptedChannel([
        { kind: "throw", error: httpError(status) },
        { kind: "chunks", chunks: [contentChunk("SHOULD NOT APPEAR")] },
      ]);
      const deps: AgentDeps = { channel };

      const chunks = await collect(runAgent(deps, agentInput({ fallbackModel: FALLBACK })));

      expect(chunks.some((c) => c.error)).toBe(true);
      expect(textOf(chunks)).toBe("");
      // No fallback attempt was made.
      expect(channel.calls).toBe(1);
    },
  );
});
