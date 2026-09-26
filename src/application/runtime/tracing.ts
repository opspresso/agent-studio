import { setTraceProcessors, setTracingDisabled, type TracingProcessor, type Span, type SpanData } from "@openai/agents";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceSpan } from "@/domain/trace/types";

export type NativeTraceSink = (span: TraceSpan) => void;
const sink = new AsyncLocalStorage<NativeTraceSink>();

/** No public exporter, queue, credentials or network are installed by this processor. */
const localProcessor: TracingProcessor = {
  async onTraceStart() {},
  async onTraceEnd() {},
  async onSpanStart() {},
  async onSpanEnd(span) {
    const write = sink.getStore();
    if (write) write(toStudioSpan(span));
  },
  async forceFlush() {},
  async shutdown() {},
};

// Replaces, rather than adds to, the SDK's default public exporter.
setTraceProcessors([localProcessor]);
// Studio's sampled, per-run sink controls local collection, including test runs.
setTracingDisabled(false);

export function nativeTracingEnabled(): boolean { return sink.getStore() !== undefined; }

export function withNativeTracing<T>(write: NativeTraceSink | undefined, run: () => Promise<T>): Promise<T> {
  return write ? sink.run(write, run) : run();
}

function toStudioSpan(span: Span<SpanData>): TraceSpan {
  const data = span.spanData;
  let kind: TraceSpan["kind"] = "prepare";
  let name: string = data.type;
  const output: Record<string, unknown> = { sdkType: data.type, sdkTraceId: span.traceId };
  let author: string | undefined;
  let input: Record<string, unknown> | undefined;
  if (data.type === "generation") {
    kind = "model";
    name = data.model ?? "model";
    const fields = { input_tokens: "inputTokens", output_tokens: "outputTokens", cost_usd: "costUsd", cached_tokens: "cachedTokens", reasoning_tokens: "reasoningTokens" } as const;
    for (const [key, field] of Object.entries(fields)) {
      const value = data.usage?.[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        if (field === "inputTokens" || field === "cachedTokens") { input ??= {}; input[field] = value; }
        else output[field] = value;
      }
    }
  } else if (data.type === "response") {
    kind = "model";
    name = "response";
  } else if (data.type === "function") {
    kind = "tool";
    name = data.name;
  } else if (data.type === "agent") {
    kind = "subagent";
    name = data.name;
    author = data.name;
  } else if (data.type === "handoff") {
    kind = "subagent";
    name = `${data.from_agent ?? "agent"} → ${data.to_agent ?? "agent"}`;
    author = data.to_agent;
  } else if (data.type === "guardrail") {
    kind = "guardrail";
    name = data.name;
    output.triggered = data.triggered;
  } else if (data.type === "mcp_tools") {
    name = `MCP: ${data.server ?? "tools"}`;
    output.toolCount = data.result?.length ?? 0;
  } else if (data.type === "task" || data.type === "custom") {
    name = data.name;
    if (data.type === "custom" && data.name === "model-routing" && Array.isArray(data.data?.routing)) output.routing = data.data.routing;
  }
  else if (data.type === "turn") {
    name = `${data.agent_name}: turn ${data.turn}`;
    output.turn = data.turn;
  }
  const startedAt = span.startedAt ?? new Date().toISOString();
  const endedAt = span.endedAt ?? startedAt;
  return {
    spanId: span.spanId, ...(span.parentId ? { parentSpanId: span.parentId } : {}),
    kind, name: name.slice(0, 200), ...(author ? { author: author.slice(0, 200) } : {}),
    startedAt, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    status: span.error || (data.type === "guardrail" && data.triggered) ? "error" : "ok",
    ...(input ? { input } : {}), output,
  };
}
