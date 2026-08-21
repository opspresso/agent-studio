import { describe, expect, it, vi } from "vitest";
import { TraceRecorder } from "@/application/trace/recorder";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";

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
  it("records model, tool, and subagent spans without storing full message content", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "parent",
      versionName: "3",
      projectType: "agent",
      model: "openai/gpt-5-mini",
      messageCount: 4,
    });

    recorder.observe({
      delta: {
        toolCalls: [
          { id: "call-1", function: { name: "search", arguments: JSON.stringify({ q: "otters" }) } },
        ],
      },
    });
    recorder.observe({
      toolResult: { toolCallId: "call-1", name: "search", content: "result" },
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
      versionName: "3",
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
    expect(JSON.stringify(traces[0])).not.toContain("full message");
  });

  it("marks a tool span failed from the shared Error: prefix", async () => {
    // The prefix is the convention every tool-result producer follows (engine
    // builtins, the skill loader, the MCP manager). It is the only signal the
    // recorder has that a tool failed.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      versionName: "1",
      projectType: "agent",
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
      versionName: "1",
      projectType: "agent",
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

  it("rolls a nested chain into the transfer that started it", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "bruce-bot",
      versionName: "1",
      projectType: "agent",
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
        versionName: "1",
        projectType: "agent",
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

  it("names the thinking share of a model span, and only when reported", async () => {
    // A turn that thought for 4,000 tokens and answered in ten looks, without
    // this, like a turn that wrote 4,010 words.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      versionName: "1",
      projectType: "agent",
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
        versionName: "1",
        projectType: "agent",
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
        versionName: "1",
        projectType: "agent",
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
      versionName: "1",
      projectType: "agent",
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
        versionName: "1",
        projectType: "agent",
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
      versionName: "1",
      projectType: "agent",
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
      versionName: "1",
      projectType: "agent",
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
      versionName: "1",
      projectType: "agent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ error: "provider unavailable" });
    await recorder.finish();

    expect(traces[0]?.status).toBe("failed");
    expect(traces[0]?.error).toBe("provider unavailable");
  });

  it("distinguishes a turn-limit ending from a normal completion", async () => {
    // The turn guard ends the generator normally, so before the reason was
    // explicit this run recorded `completed` — a run that produced no answer
    // read as normal on the traces page.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      versionName: "1",
      projectType: "agent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ warning: "The run stopped at its turn limit (2 turns)…" });
    recorder.observe({ finishReason: "turn-limit" });
    await recorder.finish();

    expect(traces[0]?.status).toBe("turn-limit");
    expect(traces[0]?.error).toBeUndefined();
  });

  it("does not mark the parent's trace from a child's turn limit", async () => {
    // An authored termination is the child's — absorbed into the parent's tool
    // result — and the parent may still answer normally.
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, {
      projectName: "p",
      versionName: "1",
      projectType: "agent",
      model: "openai/gpt-5-mini",
      messageCount: 1,
    });

    recorder.observe({ author: "child", finishReason: "turn-limit" });
    recorder.observe({ done: true });
    await recorder.finish();

    expect(traces[0]?.status).toBe("completed");
  });
});
