import { describe, expect, it } from "vitest";
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
    expect(traces[0]?.spans.map((span) => span.kind)).toEqual([
      "tool",
      "model",
      "subagent",
    ]);
    expect(traces[0]?.spans.find((span) => span.kind === "subagent")?.output).toEqual({
      subagentTraceId: "child-trace",
    });
    expect(JSON.stringify(traces[0])).not.toContain("full message");
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
