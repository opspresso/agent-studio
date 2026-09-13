import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Trace, TraceSpan } from "@/domain/trace/types";
import { createOtelTraceExport } from "@/infrastructure/telemetry/otelTraceExport";

const { exported } = vi.hoisted(() => ({ exported: [] as ReadableSpan[] }));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    export(spans: ReadableSpan[], done: (result: { code: number }) => void) { exported.push(...spans); done({ code: 0 }); }
    async shutdown() {}
  },
}));

beforeEach(() => { exported.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-13T00:00:02Z")); });
afterEach(() => vi.useRealTimers());

function span(spanId: string, parentSpanId?: string): TraceSpan {
  return { spanId, parentSpanId, name: spanId, kind: "tool", status: "ok", startedAt: "2026-09-13T00:00:00Z", endedAt: "2026-09-13T00:00:01Z", durationMs: 1000 };
}
async function send(spans: TraceSpan[]) {
  const trace: Trace = { traceId: "studio-run", projectName: "project", versionName: "v1", projectType: "agent", status: "completed",
    startedAt: "2026-09-13T00:00:00Z", endedAt: "2026-09-13T00:00:02Z", createdAt: "2026-09-13T00:00:02Z", durationMs: 2000, spans };
  const exporter = createOtelTraceExport({ endpoint: "http://collector.test", serviceName: "test" });
  exporter.exportTrace(trace);
  await exporter.flush();
  return new Map(exported.map((item) => [item.name, item]));
}

describe("native SDK hierarchy in OTLP", () => {
  it("exports child-first completion order under the actual parent without copying sensitive payloads", async () => {
    const spans = await send([
      { ...span("tool", "agent"), input: { arguments: "private-secret" }, output: { text: "private-output" } },
      span("agent", "root-agent"), span("root-agent"),
    ]);
    expect(spans.get("tool")?.parentSpanContext?.spanId).toBe(spans.get("agent")?.spanContext().spanId);
    expect(spans.get("agent")?.parentSpanContext?.spanId).toBe(spans.get("root-agent")?.spanContext().spanId);
    expect(spans.get("root-agent")?.parentSpanContext?.spanId).toBe(spans.get("agent project")?.spanContext().spanId);
    expect(spans.get("tool")?.attributes).toMatchObject({ "app.span_id": "tool", "app.parent_span_id": "agent" });
    expect(JSON.stringify(exported.map((item) => item.attributes))).not.toContain("private-");
  });

  it("attaches missing parents to the run and terminates on malformed cyclic metadata", async () => {
    const spans = await send([span("orphan", "dropped"), span("first", "second"), span("second", "first")]);
    expect(spans.size).toBe(4);
    expect(spans.get("orphan")?.parentSpanContext?.spanId).toBe(spans.get("agent project")?.spanContext().spanId);
    expect(spans.get("first")?.parentSpanContext?.spanId).toBe(spans.get("second")?.spanContext().spanId);
    expect(spans.get("second")?.parentSpanContext?.spanId).toBe(spans.get("agent project")?.spanContext().spanId);
  });
});
