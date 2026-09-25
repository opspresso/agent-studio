import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "@/application/runtime";
import { TraceRecorder } from "@/application/trace/recorder";
import type { Trace } from "@/domain/trace/types";
import type { TraceRepository } from "@/domain/trace/repository";
import { FakeChannel, contentChunk, toolCallChunk, usageChunk } from "./fakeChannel";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function recorder() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
  const saved: Trace[] = [];
  const recorder = new TraceRecorder({ put: async (trace) => { saved.push(trace); } } as TraceRepository,
    { agentName: "agent", model: "openai/gpt-5-mini", messageCount: 1 });
  recorder.useSdkRuntime();
  return { recorder, saved };
}

describe("local SDK tracing", () => {
  it("records native model, MCP and tool spans without input, credentials or public export", async () => {
    const network = vi.fn(async () => { throw new Error("Unexpected network access"); });
    vi.stubGlobal("fetch", network);
    const f = recorder();
    const channel = new FakeChannel([
      [toolCallChunk(0, "lookup", "lookup", '{"query":"private@example.com"}'), usageChunk(12, 4, 0, 0.12)],
      [contentChunk("answer"), usageChunk(8, 3, 0, 0.08)],
    ]);
    for await (const chunk of runAgent({ createToolSchemaValidator, channel, onSdkSpan: (span) => f.recorder.observeSdkSpan(span), callMcpTool: async () => ({ text: "private result with api-secret-key" }) }, {
      agentName: "agent", model: "openai/gpt-5-mini", parameters: { piiFiltering: true },
      messages: [{ role: "user", content: "private@example.com" }],
      mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      mcpServers: [{ name: "internal", description: "Private", toolNames: ["lookup"] }],
    })) f.recorder.observe(chunk);
    await f.recorder.finish();
    const trace = f.saved[0]!;
    expect(trace.status).toBe("completed");
    expect(trace.spans.filter((span) => span.kind === "model")).toHaveLength(2);
    expect(trace.spans.some((span) => span.kind === "tool" && span.name === "lookup")).toBe(true);
    expect(trace.spans.some((span) => span.output?.sdkType === "mcp_tools")).toBe(true);
    expect(trace.spans.some((span) => span.parentSpanId)).toBe(true);
    expect(trace.spans.filter((span) => span.kind === "model").map((span) => span.output?.costUsd)).toEqual([0.12, 0.08]);
    expect(JSON.stringify(trace)).not.toContain("private@example.com");
    expect(JSON.stringify(trace)).not.toContain("api-secret-key");
    expect(network).not.toHaveBeenCalled();
  });

  it("records native blocking guardrails and a failed run before model dispatch", async () => {
    const f = recorder();
    const channel = new FakeChannel([]);
    for await (const chunk of runAgent({ createToolSchemaValidator, channel, onSdkSpan: (span) => f.recorder.observeSdkSpan(span) }, {
      agentName: "agent", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "too long" }], parameters: { policy: { maxInputChars: 2 } },
    })) f.recorder.observe(chunk);
    await f.recorder.finish();
    expect(channel.calls).toBe(0);
    expect(f.saved[0]?.status).toBe("failed");
    expect(f.saved[0]?.spans).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "guardrail", name: "input-size", status: "error" })]));
  });

  it("keeps completion usage on the native model span", async () => {
    const f = recorder();
    for await (const chunk of runAgent({ channel: new FakeChannel([[contentChunk("done"), usageChunk(10, 3, 0, 0.2)]]), onSdkSpan: (span) => f.recorder.observeSdkSpan(span) }, {
      agentName: "agent", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "hello" }],
    })) f.recorder.observe(chunk);
    await f.recorder.finish();
    expect(f.saved[0]?.spans.find((span) => span.kind === "model")?.output?.costUsd).toBe(0.2);
  });
});
