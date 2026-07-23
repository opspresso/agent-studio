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
  status: TraceStatus;
  spans: TraceSpan[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  createdAt: string;
}
