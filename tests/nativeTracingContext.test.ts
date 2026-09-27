import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Span, SpanData, TracingProcessor } from "@openai/agents";
import type { TraceSpan } from "@/domain/trace/types";

const { registrations } = vi.hoisted(() => ({ registrations: [] as TracingProcessor[][] }));
vi.mock("@openai/agents", () => ({
  setTraceProcessors: (processors: TracingProcessor[]) => registrations.push(processors),
  setTracingDisabled: vi.fn(),
}));

const span = { spanId: "span-fixed", traceId: "trace-fixed", startedAt: "2026-09-26T00:00:00Z", endedAt: "2026-09-26T00:00:00Z",
  spanData: { type: "custom", name: "route bundle test", data: {} }, error: null } as unknown as Span<SpanData>;

beforeEach(() => { registrations.length = 0; vi.resetModules(); });
describe("native trace context across route bundles", () => {
  it("keeps collecting an existing run after another bundle registers the SDK processor", async () => {
    const first = await import("@/application/runtime/tracing");
    vi.resetModules();
    await import("@/application/runtime/tracing");
    expect(registrations).toHaveLength(2);
    const captured: TraceSpan[] = [];
    await first.withNativeTracing(item => captured.push(item), async () => registrations[1]![0]!.onSpanEnd(span));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ spanId: "span-fixed", name: "route bundle test" });
  });
  it("suppresses only adapter spans inside an already owned model call", async () => {
    const tracing = await import("@/application/runtime/tracing");
    const captured: TraceSpan[] = [];
    await tracing.withNativeTracing(item => captured.push(item), async () => {
      await tracing.withoutNativeTracing(async () => registrations[0]![0]!.onSpanEnd(span));
      await registrations[0]![0]!.onSpanEnd(span);
    });
    expect(captured).toHaveLength(1);
  });
});
