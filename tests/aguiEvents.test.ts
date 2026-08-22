import { describe, expect, it } from "vitest";
import type { AguiEvent } from "@/domain/agui/types";
import type { EngineChunk } from "@/domain/llm/types";
import { RateLimitedError } from "@/application/errors";
import { toAguiEvents } from "@/application/agui/events";

const RUN = { threadId: "t1", runId: "r1" };

function ids(): () => string {
  let n = 0;
  return () => `id${++n}`;
}

async function* chunks(list: EngineChunk[]): AsyncGenerator<EngineChunk> {
  for (const chunk of list) {
    yield chunk;
  }
}

async function collect(source: AsyncGenerator<AguiEvent>): Promise<AguiEvent[]> {
  const events: AguiEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function translate(list: EngineChunk[], sign?: (key: string) => Promise<string>): Promise<AguiEvent[]> {
  return collect(toAguiEvents(chunks(list), RUN, { newId: ids(), ...(sign ? { sign } : {}) }));
}

const types = (events: AguiEvent[]) => events.map((event) => event.type);

describe("toAguiEvents — lifecycle", () => {
  it("opens the run, streams a text message, and closes both on done", async () => {
    const events = await translate([
      { delta: { content: "Hel" } },
      { delta: { content: "lo" } },
      { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, done: true },
    ]);
    expect(events).toEqual([
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "id1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "id1", delta: "Hel" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "id1", delta: "lo" },
      { type: "TEXT_MESSAGE_END", messageId: "id1" },
      {
        type: "RUN_FINISHED",
        threadId: "t1",
        runId: "r1",
        outcome: { type: "success" },
        result: { termination: "completed", warnings: [] },
        usage: [{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
      },
    ]);
  });

  it("finishes a stream that ended without a terminal chunk", async () => {
    const events = await translate([{ delta: { content: "x" } }]);
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("carries the engine's termination reason and warnings on RUN_FINISHED", async () => {
    const events = await translate([
      { warning: "MCP server 'x' is no longer in the registry; its tools were not offered." },
      { delta: { content: "partial" } },
      { warning: "The run reached its turn limit (3 turns)." },
      // Repeated warnings are said once.
      { warning: "The run reached its turn limit (3 turns)." },
      { finishReason: "turn-limit" },
    ]);
    const finished = events.at(-1);
    expect(finished).toMatchObject({
      type: "RUN_FINISHED",
      result: {
        termination: "turn-limit",
        warnings: [
          "MCP server 'x' is no longer in the registry; its tools were not offered.",
          "The run reached its turn limit (3 turns).",
        ],
      },
    });
    expect(events.filter((event) => event.type === "CUSTOM" && event.name === "agent-studio.warning")).toHaveLength(2);
  });

  it("pulls the first chunk before RUN_STARTED so a refusal reaches the route as a throw", async () => {
    async function* refused(): AsyncGenerator<EngineChunk> {
      throw new RateLimitedError("over the daily cost limit", 42);
      // eslint-disable-next-line no-unreachable
      yield { done: true };
    }
    await expect(collect(toAguiEvents(refused(), RUN))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("reports a failure after the first chunk as RUN_ERROR, closing what was open", async () => {
    async function* failing(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "so far" } };
      throw new Error("provider went away");
    }
    const events = await collect(toAguiEvents(failing(), RUN, { newId: ids() }));
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
    expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "provider went away" });
  });

  it("turns a top-level error chunk into RUN_ERROR and ignores what follows", async () => {
    const events = await translate([
      { delta: { content: "a" } },
      { error: "Upstream 502" },
      { delta: { content: "never" } },
      { done: true },
    ]);
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
  });
});

describe("toAguiEvents — tool calls", () => {
  it("announces a call as start/args/end, parented to the text it followed, then its result", async () => {
    const events = await translate([
      { delta: { content: "Let me check." } },
      {
        delta: {
          toolCalls: [
            { id: "call_1", type: "function", function: { name: "getWeather", arguments: '{"city":"Seoul"}' } },
          ],
        },
      },
      { toolResult: { toolCallId: "call_1", name: "getWeather", content: "sunny" } },
      { delta: { content: "\n" } },
      { delta: { content: "It is sunny." } },
      { done: true },
    ]);
    expect(events.slice(1, -1)).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "id1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "id1", delta: "Let me check." },
      { type: "TEXT_MESSAGE_END", messageId: "id1" },
      { type: "TOOL_CALL_START", toolCallId: "call_1", toolCallName: "getWeather", parentMessageId: "id1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call_1", delta: '{"city":"Seoul"}' },
      { type: "TOOL_CALL_END", toolCallId: "call_1" },
      { type: "TOOL_CALL_RESULT", messageId: "id2", toolCallId: "call_1", content: "sunny", role: "tool" },
      // A new turn is a new assistant message.
      { type: "TEXT_MESSAGE_START", messageId: "id3", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "id3", delta: "\n" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "id3", delta: "It is sunny." },
      { type: "TEXT_MESSAGE_END", messageId: "id3" },
    ]);
  });

  it("parents every call of a turn to one assistant message, whether or not the turn spoke", async () => {
    const events = await translate([
      { delta: { content: "hi" } },
      { delta: { toolCalls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }] } },
      { delta: { toolCalls: [{ id: "c2", type: "function", function: { name: "b", arguments: "" } }] } },
      { toolResult: { toolCallId: "c1", name: "a", content: "1" } },
      { toolResult: { toolCallId: "c2", name: "b", content: "2" } },
      { delta: { toolCalls: [{ id: "c3", type: "function", function: { name: "c", arguments: "{}" } }] } },
      { done: true },
    ]);
    const starts = events.filter((event) => event.type === "TOOL_CALL_START");
    expect(starts).toEqual([
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "a", parentMessageId: "id1" },
      { type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "b", parentMessageId: "id1" },
      // The next turn called without speaking: still one message, a fresh one,
      // rather than a client-invented bubble per call.
      { type: "TOOL_CALL_START", toolCallId: "c3", toolCallName: "c", parentMessageId: "id4" },
    ]);
    // Empty arguments are not an ARGS frame.
    expect(events.filter((event) => event.type === "TOOL_CALL_ARGS").map((event) => event.toolCallId)).toEqual([
      "c1",
      "c3",
    ]);
  });
});

describe("toAguiEvents — reasoning, steps and the other axes", () => {
  it("streams reasoning as its own block, closed when the answer begins", async () => {
    const events = await translate([
      { delta: { reasoningContent: "think" } },
      { delta: { reasoningContent: "ing" } },
      { delta: { content: "answer" } },
      { done: true },
    ]);
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[2]).toEqual({ type: "REASONING_MESSAGE_START", messageId: "id1", role: "reasoning" });
  });

  it("reports a subagent as a step and never as the answer, while keeping its picture and warning", async () => {
    const events = await translate([
      { delta: { toolCalls: [{ id: "c1", type: "function", function: { name: "transfer_to_agent", arguments: "{}" } }] } },
      { author: "painter", authorPath: ["painter"], delta: { content: "child text" } },
      { author: "painter", authorPath: ["painter"], warning: "child lost a binding" },
      { author: "painter", authorPath: ["painter"], image: { b64: "AAAA", mimeType: "image/png", model: "x/img" } },
      { author: "painter", authorPath: ["painter"], error: "child failed", authorDone: true },
      { toolResult: { toolCallId: "c1", name: "transfer_to_agent: painter", content: "Transferred.", displayOnly: true } },
      { delta: { content: "done" } },
      { done: true },
    ]);
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "STEP_STARTED",
      "CUSTOM",
      "ACTIVITY_SNAPSHOT",
      "STEP_FINISHED",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[4]).toEqual({ type: "STEP_STARTED", stepName: "painter" });
    expect(events[5]).toEqual({ type: "CUSTOM", name: "agent-studio.warning", value: { message: "child lost a binding" } });
    expect(events[6]).toEqual({
      type: "ACTIVITY_SNAPSHOT",
      messageId: "id2",
      activityType: "agent-studio.image",
      content: { mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA", model: "x/img" },
    });
    // The child's text never became a message; its failure never ended the run.
    expect(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "child text")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { warnings: ["child lost a binding"] } });
  });

  it("closes a step the child never closed when the run ends", async () => {
    const events = await translate([
      { author: "helper", authorPath: ["helper"], delta: { content: "…" } },
      { done: true },
    ]);
    expect(types(events)).toEqual(["RUN_STARTED", "STEP_STARTED", "STEP_FINISHED", "RUN_FINISHED"]);
  });

  it("addresses a produced file, and reports one it cannot address", async () => {
    const file = { mimeType: "application/pdf", name: "report.pdf", source: "mcp: render", key: "k1", byteSize: 12 };
    const signed = await translate([{ file }, { done: true }], async (key) => `https://files/${key}`);
    expect(signed[1]).toEqual({
      type: "ACTIVITY_SNAPSHOT",
      messageId: "id1",
      activityType: "agent-studio.file",
      content: { name: "report.pdf", mimeType: "application/pdf", byteSize: 12, url: "https://files/k1" },
    });

    const unsigned = await translate([{ file }, { done: true }]);
    expect(unsigned[1]).toMatchObject({ type: "CUSTOM", name: "agent-studio.warning" });
    expect(unsigned.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: { warnings: [expect.stringContaining("not kept")] } });
  });

  it("sums usage over every call, subset fields included", async () => {
    const events = await translate([
      { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, cachedTokens: 4, reasoningTokens: 2 } },
      { author: "child", usage: { inputTokens: 3, outputTokens: 1, costUsd: 0 }, authorDone: true },
      { usage: { inputTokens: 7, outputTokens: 2, costUsd: 0, reasoningTokens: 1 }, done: true },
    ]);
    expect(events.at(-1)).toMatchObject({
      usage: [{ inputTokens: 20, outputTokens: 8, totalTokens: 28, reasoningTokens: 3, cachedInputTokens: 4 }],
    });
  });
});

describe("toAguiEvents — what the ending has to wait for and close", () => {
  it("delivers a warning that arrives after the terminal chunk, and finishes only when the source is exhausted", async () => {
    // The artifact recorder says what it could not keep only after the engine's
    // stream ended — after `done` — so a finish on the terminal chunk loses it.
    const events = await translate([
      { delta: { content: "drawn" } },
      { done: true },
      { warning: "The image was drawn but not kept: object storage refused the write." },
    ]);
    expect(types(events)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "CUSTOM",
      "RUN_FINISHED",
    ]);
    expect(events.at(-1)).toMatchObject({
      result: {
        termination: "completed",
        warnings: ["The image was drawn but not kept: object storage refused the write."],
      },
    });
  });

  it("says the surface's own warnings right after RUN_STARTED and collects them", async () => {
    const events = await collect(
      toAguiEvents(chunks([{ done: true }]), RUN, { warnings: ["2 application tool(s) were not offered"] }),
    );
    expect(events[1]).toEqual({
      type: "CUSTOM",
      name: "agent-studio.warning",
      value: { message: "2 application tool(s) were not offered" },
    });
    expect(events.at(-1)).toMatchObject({ result: { warnings: ["2 application tool(s) were not offered"] } });
  });

  it("closes the source when the reader leaves at RUN_STARTED", async () => {
    // The first thing every run sends is a yield nothing delegates through: a
    // `return()` parked there must still reach the run, or its bracket never
    // closes and the concurrency slot is held until the deadline.
    let closed = false;
    async function* source(): AsyncGenerator<EngineChunk> {
      try {
        yield { delta: { content: "x" } };
        yield { done: true };
      } finally {
        closed = true;
      }
    }
    const events = toAguiEvents(source(), RUN);
    expect((await events.next()).value).toEqual({ type: "RUN_STARTED", threadId: "t1", runId: "r1" });
    expect(closed).toBe(false);
    await events.return(undefined);
    expect(closed).toBe(true);
  });
});

describe("toAguiEvents — identity and naming", () => {
  it("echoes parentRunId, names the model on usage, and codes a typed failure", async () => {
    async function* failing(): AsyncGenerator<EngineChunk> {
      yield { usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      throw new RateLimitedError("over", 1);
    }
    const events = await collect(
      toAguiEvents(failing(), { ...RUN, parentRunId: "r0" }, { newId: ids(), model: "openai/gpt-5-mini" }),
    );
    expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "t1", runId: "r1", parentRunId: "r0" });
    expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "over", code: "RateLimitedError" });

    const finished = await collect(
      toAguiEvents(chunks([{ usage: { inputTokens: 2, outputTokens: 3, costUsd: 0 }, done: true }]), RUN, {
        model: "openai/gpt-5-mini",
      }),
    );
    expect(finished.at(-1)).toMatchObject({ usage: [{ model: "openai/gpt-5-mini", totalTokens: 5 }] });
  });

  it("names a step by its chain, so two children of one agent do not share one", async () => {
    const events = await translate([
      { author: "b", authorPath: ["a", "b"], delta: { content: "…" } },
      { author: "b", authorPath: ["a", "b"], authorDone: true },
      { done: true },
    ]);
    expect(events.slice(1, 3)).toEqual([
      { type: "STEP_STARTED", stepName: "a/b" },
      { type: "STEP_FINISHED", stepName: "a/b" },
    ]);
  });
});
