import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { TraceContent } from "@/app/agents/[name]/traces/TraceContent";
import type { Trace } from "@/domain/trace/types";

describe("routing trace presentation", () => {
  it("renders model selection, promotion and rejection reasons instead of object placeholders", () => {
    const time = "2026-09-26T00:00:00Z";
    const trace: Trace = { traceId: "trace", agentName: "agent", status: "completed", startedAt: time, endedAt: time,
      durationMs: 1, createdAt: time, spans: [{ spanId: "routing", kind: "prepare", name: "model-routing", status: "ok",
        startedAt: time, endedAt: time, durationMs: 1, output: { routing: [
          { purpose: "summary", model: "local/fast", tier: "fast", source: "policy", outcome: "quality-rejected", attempt: 1 },
          { purpose: "summary", model: "local/strong", tier: "reasoning", source: "promotion", outcome: "completed", attempt: 2 },
          { purpose: "vision", model: "external/model", source: "explicit", outcome: "rejected", attempt: 0, reason: "security" },
          null,
        ] } }] };
    const markup = renderToStaticMarkup(createElement(MantineProvider, { children: createElement(TraceContent, { trace }) }));
    expect(markup).toContain("summary → local/fast (fast) · policy · quality-rejected · #1");
    expect(markup).toContain("summary → local/strong (reasoning) · promotion · completed · #2");
    expect(markup).toContain("vision → external/model · explicit · rejected · security");
    expect(markup).not.toContain("[object Object]");
  });
});
