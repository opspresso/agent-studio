import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}`,
}));
import { TraceRecorder } from "@/application/trace/recorder";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace, TraceSpan } from "@/domain/trace/types";

beforeEach(() => {
  ids.sequence = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
});
afterEach(() => vi.useRealTimers());

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
      async listByAgent(agentName) {
        return traces.filter((trace) => trace.agentName === agentName);
      },
    },
  };
}

function span(id: string, parentSpanId?: string): TraceSpan {
  return { spanId: id, parentSpanId, kind: "model", name: "actual-model", status: "ok",
    startedAt: "2026-01-01T00:00:10.000Z", endedAt: "2026-01-01T00:00:12.000Z", durationMs: 2000,
    input: { inputTokens: 10, cachedTokens: 3 }, output: { outputTokens: 7, reasoningTokens: 4, costUsd: 0.2 } };
}

describe("TraceRecorder", () => {
  it("preserves native spans and hierarchy without rebuilding them from display chunks", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    const child = span("child", "parent");
    const parent = { ...span("parent"), kind: "subagent" as const, name: "p" };
    recorder.observeSdkSpan(child);
    recorder.observeSdkSpan(parent);
    recorder.observe({ delta: { toolCalls: [{ id: "call", function: { name: "search", arguments: "private argument" } }] } });
    recorder.observe({ toolResult: { toolCallId: "call", name: "search", content: "private result" } });
    recorder.observe({ usage: { inputTokens: 10, outputTokens: 7, costUsd: 0.2 } });
    recorder.observe({ author: "child", usage: { inputTokens: 10, outputTokens: 7, costUsd: 0.2 } });
    await recorder.finish();
    expect(traces[0]!.spans).toEqual([child, parent]);
    expect(JSON.stringify(traces[0])).not.toContain("private");
  });

  it("records preparation timing independently of native model timing", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    const started = new Date();
    vi.setSystemTime("2026-01-01T00:00:10.000Z");
    recorder.observePrepare("tools", started, { output: { mcpTools: 30 } });
    recorder.observeSdkSpan(span("model"));
    vi.setSystemTime("2026-01-01T00:00:12.000Z");
    await recorder.finish();
    expect(traces[0]!.spans.map(item => [item.kind, item.durationMs])).toEqual([["prepare", 10000], ["model", 2000]]);
    expect(traces[0]!.durationMs).toBe(12000);
  });

  it("bounds preparation metadata without storing arbitrary objects", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observePrepare("tools", new Date(), { output: {
      mcpTools: 30, discoveredNames: Array.from({ length: 50 }, (_, at) => `server-${at}`),
      note: "x".repeat(5000), payload: { nested: "private" },
      ...Object.fromEntries(Array.from({ length: 25 }, (_, at) => [`field-${at}`, at])),
    } });
    await recorder.finish();
    const output = traces[0]!.spans[0]!.output!;
    expect(output.mcpTools).toBe(30);
    expect(output.discoveredNames).toHaveLength(20);
    expect(output.note).toBe("x".repeat(1000) + "…");
    expect(output.payload).toBeUndefined();
    expect(output["field-24"]).toBeUndefined();
    expect(Object.keys(output).length).toBeLessThanOrEqual(20);
  });

  it("keeps bounded warning, error and preparation text valid Unicode", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    const text = "x".repeat(999) + "😀";
    recorder.observePrepare("tools", new Date(), { output: { note: text, names: [text] } });
    recorder.observe({ warning: text, error: text });
    await recorder.finish();
    const trace = traces[0]!;
    const output = trace.spans[0]!.output!;
    for (const value of [trace.warnings![0]!, trace.error!, output.note as string, (output.names as string[])[0]!]) {
      expect(value.isWellFormed()).toBe(true);
      expect(value).toBe("x".repeat(999) + "…");
    }
  });

  it("keeps a recoverable preparation failure separate from the run outcome", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observePrepare("memory", new Date(), { status: "error", output: { warnings: 1 } });
    recorder.observeSdkSpan(span("model"));
    await recorder.finish();
    expect(traces[0]!.status).toBe("completed");
    expect(traces[0]!.spans[0]!.status).toBe("error");
  });

  it("counts spans omitted at the storage bound and bounds warnings from all agents", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    for (let index = 0; index < 105; index++) recorder.observeSdkSpan(span(`model-${index}`));
    for (let index = 0; index < 25; index++) recorder.observe({ author: "child", warning: `warning-${index}` });
    await recorder.finish();
    expect(traces[0]!.spans).toHaveLength(100);
    expect(traces[0]!.spansDropped).toBe(5);
    expect(traces[0]!.warnings).toHaveLength(20);
    expect(traces[0]!.warnings!.at(-1)).toBe("warning-19");
  });

  it.each(["turn-limit", "output-limit"] as const)("records a top-level %s ending", async limit => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observe({ finishReason: limit });
    await recorder.finish();
    expect(traces[0]!.status).toBe(limit);
  });

  it.each(["error", "turn-limit", "output-limit", "approval"] as const)("keeps a child's %s separate from the parent outcome", async ending => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observe({ author: "child", ...(ending === "error" ? { error: "child failed" } : ending === "approval"
      ? { approval: { pending: true as const } } : { finishReason: ending }) });
    recorder.observe({ done: true });
    await recorder.finish();
    expect(traces[0]!.status).toBe("completed");
    expect(traces[0]!.error).toBeUndefined();
  });

  it("records the native approval wait", async () => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observe({ approval: { pending: true } });
    await recorder.finish();
    expect(traces[0]!.status).toBe("awaiting-approval");
  });

  it.each(["chunk", "throw", "cancel"] as const)("gives %s precedence over an output limit", async ending => {
    const { repository, traces } = memoryRepository();
    const recorder = new TraceRecorder(repository, { agentName: "p" });
    recorder.observe({ finishReason: "output-limit" });
    if (ending === "chunk") recorder.observe({ error: "provider unavailable" });
    await recorder.finish(ending === "chunk" ? undefined : new Error("provider unavailable"), ending === "cancel");
    expect(traces[0]!.status).toBe(ending === "cancel" ? "cancelled" : "failed");
    expect(traces[0]!.error).toBe(ending === "cancel" ? undefined : "provider unavailable");
  });
});
