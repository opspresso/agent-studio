import { describe, expect, it, vi } from "vitest";
import { TraceRecorder } from "@/application/trace/recorder";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import type { EngineChunk } from "@/domain/llm/types";

function memoryRepository(): { repository: TraceRepository; traces: Trace[] } {
  const traces: Trace[] = [];
  return {
    traces,
    repository: {
      async put(trace) {
        traces.push(trace);
      },
      async get(traceId) {
        return traces.find((trace) => trace.traceId === traceId) ?? null;
      },
      async listByProject(projectName) {
        return traces.filter((trace) => trace.projectName === projectName);
      },
    },
  };
}

describe("TraceRecorder", () => {
  it.each([false, true])("pairs parent and nested tool calls independently when sampled=%s", async (sampled) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "parent", model: "model", messageCount: 1,
      });
      const contexts: Partial<EngineChunk>[] = [
        {},
        { author: "child", authorPath: ["child"], transferId: "delegation" },
        { author: "grandchild", authorPath: ["child", "grandchild"], transferId: "delegation" },
      ];
      const names = ["parent-tool", "child-tool", "grandchild-tool"];
      const args = ["{}", '{"x":1}', '{"query":"value"}'];
      for (let index = 0; index < contexts.length; index += 1) {
        vi.setSystemTime(index * 1000);
        recorder.observe({
          ...contexts[index],
          ...(sampled ? { traceId: "sampled-trace" } : {}),
          delta: { toolCalls: [{ id: "call_1", function: { name: names[index], arguments: args[index] } }] },
        });
      }
      for (const [index, time] of [[2, 5000], [1, 6000], [0, 9000]] as const) {
        vi.setSystemTime(time);
        recorder.observe({
          ...contexts[index],
          ...(sampled ? { traceId: "sampled-trace" } : {}),
          toolResult: { toolCallId: "call_1", name: "result", content: "ok" },
        });
      }
      await recorder.finish();

      const tools = traces[0]!.spans.filter((span) => span.kind === "tool");
      expect(new Set(traces[0]!.spans.map((span) => span.spanId)).size).toBe(traces[0]!.spans.length);
      expect(tools.map((span) => [span.name, span.author, span.durationMs, span.input?.argumentChars])).toEqual([
        ["grandchild-tool", "grandchild", 3000, args[2]!.length],
        ["child-tool", "child", 5000, args[1]!.length],
        ["parent-tool", undefined, 9000, args[0]!.length],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("pairs overlapping transfers to the same child when sampled=%s", async (sampled) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "parent", model: "model", messageCount: 1,
      });
      const context = (transferId: string) => ({
        author: "child",
        authorPath: ["child"],
        transferId,
        ...(sampled ? { traceId: `trace-${transferId}` } : {}),
      });
      recorder.observe({
        ...context("first"),
        delta: { toolCalls: [{ id: "call_1", function: { name: "first-tool", arguments: "{}" } }] },
      });
      vi.setSystemTime(1000);
      recorder.observe({
        ...context("second"),
        delta: { toolCalls: [{ id: "call_1", function: { name: "second-tool", arguments: '{"x":1}' } }] },
      });
      vi.setSystemTime(3000);
      recorder.observe({ ...context("first"), toolResult: { toolCallId: "call_1", name: "result", content: "ok" } });
      vi.setSystemTime(7000);
      recorder.observe({ ...context("second"), toolResult: { toolCallId: "call_1", name: "result", content: "ok" } });
      await recorder.finish();

      expect(new Set(traces[0]!.spans.map((span) => span.spanId)).size).toBe(traces[0]!.spans.length);
      expect(traces[0]!.spans.filter((span) => span.kind === "tool")
        .map((span) => [span.name, span.durationMs, span.input?.argumentChars])).toEqual([
        ["first-tool", 3000, 2],
        ["second-tool", 6000, 7],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records tool and subagent metadata without storing tool inputs or outputs", async () => {
    const inputMarker = "TRACE_PRIVATE_TOOL_ARGUMENT_8fa290";
    const outputMarker = "TRACE_PRIVATE_TOOL_RESULT_01bd75";
    const argumentsText = JSON.stringify({ q: inputMarker });
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      model: "openai/gpt-5-mini",
      messageCount: 4,
    });

    recorder.observe({
      delta: {
        toolCalls: [
          { id: "call-1", function: { name: "search", arguments: argumentsText } },
        ],
      },
    });
    recorder.observe({
      toolResult: { toolCallId: "call-1", name: "search", content: outputMarker },
    });
    recorder.observe({
      author: "child",
      traceId: "child-trace",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    await recorder.finish();

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      projectName: "parent",
      status: "completed",
    });
    // A subagent's tokens do NOT become a model span here: this run does not know
    // the child's model, so they roll up onto the subagent span instead.
    expect(traces[0]?.spans.map((span) => span.kind)).toEqual(["tool", "subagent"]);
    expect(traces[0]?.spans.find((span) => span.kind === "subagent")?.output).toEqual({
      subagentTraceId: "child-trace",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });
    expect(traces[0]?.spans.find((span) => span.kind === "tool")).toMatchObject({
      input: { argumentChars: argumentsText.length },
      output: { contentChars: outputMarker.length },
    });
    const stored = JSON.stringify(traces[0]);
    expect(stored).not.toContain(inputMarker);
    expect(stored).not.toContain(outputMarker);
  });

  it("marks a tool span failed from the shared Error: prefix", async () => {
    // The prefix is the convention every tool-result producer follows (engine
    // builtins, the skill loader, the MCP manager). It is the only signal the
    // recorder has that a tool failed.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({
      delta: { toolCalls: [{ id: "call-1", function: { name: "lookup", arguments: "{}" } }] },
    });
    recorder.observe({
      toolResult: { toolCallId: "call-1", name: "lookup", content: "Error: tool call failed." },
    });
    await recorder.finish();

    const span = traces[0]?.spans.find((s) => s.kind === "tool");
    expect(span?.status).toBe("error");
  });

  it("keeps two transfers to the same agent as two spans", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ author: "child", traceId: "run-1", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
    recorder.observe({ author: "child", traceId: "run-2", usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.002 } });
    await recorder.finish();

    const subagentSpans = traces[0]?.spans.filter((span) => span.kind === "subagent") ?? [];
    expect(subagentSpans).toHaveLength(2);
    expect(subagentSpans.map((span) => span.output?.subagentTraceId)).toEqual(["run-1", "run-2"]);
  });

  it("keeps unsampled transfers separate and folds their completion chunks", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({
      author: "child",
      transferId: "transfer-1",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    });
    recorder.observe({ author: "child", transferId: "transfer-1", authorDone: true });
    recorder.observe({
      author: "child",
      transferId: "transfer-2",
      usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.002 },
    });
    recorder.observe({ author: "child", transferId: "transfer-2", authorDone: true });
    await recorder.finish();

    const subagentSpans = traces[0]?.spans.filter((span) => span.kind === "subagent") ?? [];
    expect(subagentSpans).toHaveLength(2);
    expect(subagentSpans.map((span) => span.output?.inputTokens)).toEqual([1, 2]);
  });

  it("rolls a nested chain into the transfer that started it", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "bruce-bot",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ author: "sample-agent", authorPath: ["sample-agent"], traceId: "t-mid", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
    recorder.observe({
      author: "simple-image",
      authorPath: ["sample-agent", "simple-image"],
      traceId: "t-mid",
      usage: { inputTokens: 5, outputTokens: 50, costUsd: 0.02 },
    });
    await recorder.finish();

    const spans = traces[0]?.spans.filter((span) => span.kind === "subagent") ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("sample-agent");
    expect(spans[0]?.output).toMatchObject({
      chain: "sample-agent → simple-image",
      subagentTraceId: "t-mid",
      // Everything the transfer cost this run, both levels together.
      inputTokens: 6,
      outputTokens: 51,
    });
  });

  it("does not bill a transfer's duration to the parent's next model span", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "parent",
        model: "openai/gpt-5-mini",
        messageCount: 1,
      });

      // Turn 1: a one-second model call that ends in a transfer.
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      recorder.observe({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
      // The child streams for forty seconds.
      vi.setSystemTime(new Date("2026-01-01T00:00:41.000Z"));
      recorder.observe({
        author: "child",
        traceId: "t",
        usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.002 },
      });
      // Turn 2: the parent resumes and answers in two seconds.
      vi.setSystemTime(new Date("2026-01-01T00:00:43.000Z"));
      recorder.observe({ usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.001 } });
      await recorder.finish();

      const modelSpans = traces[0]?.spans.filter((span) => span.kind === "model") ?? [];
      expect(modelSpans.map((span) => span.durationMs)).toEqual([1000, 2000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the model that actually produced a fallback turn", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/primary",
      messageCount: 1,
    });

    recorder.observe({
      usage: {
        model: "anthropic/fallback",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
      },
    });
    await recorder.finish();

    expect(traces[0]?.spans.find((span) => span.kind === "model")?.name).toBe(
      "anthropic/fallback",
    );
  });

  it("names the thinking share of a model span, and only when reported", async () => {
    // A turn that thought for 4,000 tokens and answered in ten looks, without
    // this, like a turn that wrote 4,010 words.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({
      usage: { inputTokens: 1, outputTokens: 4010, costUsd: 0.01, reasoningTokens: 4000 },
    });
    recorder.observe({ usage: { inputTokens: 1, outputTokens: 10, costUsd: 0.001 } });
    await recorder.finish();

    const outputs = (traces[0]?.spans ?? [])
      .filter((span) => span.kind === "model")
      .map((span) => span.output?.reasoningTokens);
    // Absent, not zero, on the turn nobody reported one for.
    expect(outputs).toEqual([4000, undefined]);
  });

  it("does not bill preparation to the first model span", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { repository, traces } = memoryRepository();
      // Constructed before the version's tools resolve, on purpose: a resolve
      // that throws must still leave a trace.
      const recorder = new TraceRecorder(repository, {
        projectName: "parent",
        model: "openai/gpt-5-mini",
        messageCount: 1,
      });

      // Eight seconds opening MCP sessions and listing their tools.
      const resolveStartedAt = new Date();
      vi.setSystemTime(new Date("2026-01-01T00:00:08.000Z"));
      recorder.observePrepare("tools", resolveStartedAt, { output: { mcpServers: 2, mcpTools: 30 } });
      // Then two on memory, which this version asked for.
      const recallStartedAt = new Date();
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      recorder.observePrepare("memory", recallStartedAt, { output: { remembered: 512 } });
      // The model itself answers in one and a half.
      vi.setSystemTime(new Date("2026-01-01T00:00:11.500Z"));
      recorder.observe({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
      await recorder.finish();

      const spans = traces[0]?.spans ?? [];
      expect(spans.filter((span) => span.kind === "prepare").map((span) => [span.name, span.durationMs]))
        .toEqual([
          ["tools", 8000],
          ["memory", 2000],
        ]);
      expect(spans.filter((span) => span.kind === "model").map((span) => span.durationMs)).toEqual([
        1500,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bill a tool's wait to the model call that follows it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "parent",
        model: "openai/gpt-5-mini",
        messageCount: 1,
      });

      // Turn 1 answers in a second and asks for a tool.
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
      recorder.observe({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
      recorder.observe({
        delta: { toolCalls: [{ id: "call-1", function: { name: "search", arguments: "{}" } }] },
      });
      // The tool takes eight seconds.
      vi.setSystemTime(new Date("2026-01-01T00:00:09.000Z"));
      recorder.observe({ toolResult: { toolCallId: "call-1", name: "search", content: "ok" } });
      // Turn 2 answers in one and a half.
      vi.setSystemTime(new Date("2026-01-01T00:00:10.500Z"));
      recorder.observe({ usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.001 } });
      await recorder.finish();

      const spans = traces[0]?.spans ?? [];
      expect(spans.filter((span) => span.kind === "tool").map((span) => span.durationMs)).toEqual([
        8000,
      ]);
      expect(spans.filter((span) => span.kind === "model").map((span) => span.durationMs)).toEqual([
        1000, 1500,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds what a stage may put on its span", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observePrepare("tools", new Date(), {
      output: {
        mcpTools: 30,
        discoveredNames: Array.from({ length: 50 }, (_, at) => `server-${at}`),
        note: "x".repeat(5_000),
        // Not metadata about a stage; dropped rather than serialised blind.
        payload: { nested: "object" },
      },
    });
    await recorder.finish();

    const output = traces[0]?.spans[0]?.output ?? {};
    expect(output.mcpTools).toBe(30);
    expect((output.discoveredNames as string[]).length).toBe(20);
    expect((output.note as string).length).toBeLessThan(1_100);
    expect(output.payload).toBeUndefined();
  });

  it("marks a stage that failed without failing the run it prepared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "parent",
        model: "openai/gpt-5-mini",
        messageCount: 1,
      });

      // A memory server that timed out: the run goes on without a memory, and
      // the warning it yields is what the reader sees beside this span.
      const recallStartedAt = new Date();
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      recorder.observePrepare("memory", recallStartedAt, {
        status: "error",
        output: { remembered: 0, warnings: 1 },
      });
      vi.setSystemTime(new Date("2026-01-01T00:00:11.000Z"));
      recorder.observe({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } });
      await recorder.finish();

      const prepare = traces[0]?.spans.find((span) => span.kind === "prepare");
      expect(prepare?.status).toBe("error");
      expect(prepare?.durationMs).toBe(10_000);
      // The run answered, so it is not a failed trace — the same rule a failed
      // transfer follows.
      expect(traces[0]?.status).toBe("completed");
      expect(traces[0]?.spans.find((span) => span.kind === "model")?.durationMs).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the subagent span, not the run, when a transfer errors", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ author: "child", traceId: "t", error: "Unknown agent 'nope'." });
    await recorder.finish();

    // The parent saw a tool error and can still answer, so the run is not failed.
    expect(traces[0]?.status).toBe("completed");
    const span = traces[0]?.spans.find((s) => s.kind === "subagent");
    expect(span?.status).toBe("error");
    expect(span?.output?.error).toBe("Unknown agent 'nope'.");
  });

  it("counts spans dropped past the cap instead of hiding them", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    for (let i = 0; i < 105; i += 1) {
      recorder.observe({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    }
    await recorder.finish();

    expect(traces[0]?.spans).toHaveLength(100);
    expect(traces[0]?.spansDropped).toBe(5);
  });

  it("marks a trace failed when an error chunk is observed", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ error: "provider unavailable" });
    await recorder.finish();

    expect(traces[0]?.status).toBe("failed");
    expect(traces[0]?.error).toBe("provider unavailable");
  });

  it("records caller cancellation instead of the abort error that delivered it", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });
    const aborted = new Error("ResponseAborted");

    recorder.observe({ error: aborted.message });
    await recorder.finish(aborted, true);

    expect(traces[0]?.status).toBe("cancelled");
    expect(traces[0]?.error).toBeUndefined();
  });

  it.each(["turn-limit", "output-limit"] as const)("distinguishes a %s ending from a normal completion", async (limit) => {
    // A normally exhausted generator can still carry an incomplete answer.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ finishReason: limit });
    await recorder.finish();

    expect(traces[0]?.status).toBe(limit);
    expect(traces[0]?.error).toBeUndefined();
  });

  it.each(["turn-limit", "output-limit"] as const)("does not mark the parent's trace from a child's %s", async (limit) => {
    // An authored termination is the child's — absorbed into the parent's tool
    // result — and the parent may still answer normally.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ author: "child", finishReason: limit });
    recorder.observe({ done: true });
    await recorder.finish();

    expect(traces[0]?.status).toBe("completed");
  });

  it.each([undefined, "failed", "cancelled"] as const)("records a single-shot output limit with %s taking precedence", async (ending) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { repository, traces } = memoryRepository();
      const recorder = new TraceRecorder(repository, {
        projectName: "p", model: "model", messageCount: 1,
      });
      recorder.observeResult({
        content: "partial", model: "model", usage: { inputTokens: 5, outputTokens: 10, costUsd: 0 },
        termination: "output-limit",
      });
      await recorder.finish(ending ? new Error("interrupted") : undefined, ending === "cancelled");
      expect(traces[0]?.status).toBe(ending ?? "output-limit");
    } finally {
      vi.useRealTimers();
    }
  });
});
