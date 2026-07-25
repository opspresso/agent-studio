export type TraceStatus = "completed" | "failed" | "cancelled";
export type TraceSpanKind = "model" | "tool" | "subagent";

export interface TraceSpan {
  spanId: string;
  kind: TraceSpanKind;
  name: string;
  author?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface Trace {
  traceId: string;
  projectName: string;
  versionName: string;
  projectType: string;
  /**
   * Transfer chain that reached this run, outermost first — the last element is
   * this run's own project. Present on nested runs so a trace can be read
   * upwards, not only downwards through `subagentTraceId`.
   */
  ancestry?: string[];
  status: TraceStatus;
  spans: TraceSpan[];
  /** Spans dropped after the per-trace cap; absent when nothing was dropped. */
  spansDropped?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  createdAt: string;
}
