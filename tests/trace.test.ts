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
});
