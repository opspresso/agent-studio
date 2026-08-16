import type { RunActor } from "@/domain/execution/actor";

/**
 * `turn-limit` is distinct from `completed` because a run the turn guard ended
 * produced no final answer — recording it as completed made the one run worth
 * investigating read as normal on the traces page.
 */
export type TraceStatus = "completed" | "turn-limit" | "failed" | "cancelled";
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
   * Who caused the run. A subagent's trace carries the actor of the top-level
   * run that reached it — the transfer was not a second person's decision.
   * Absent on traces written before attribution existed.
   */
  actor?: RunActor;
  /**
   * Transfer chain that reached this run, outermost first — the last element is
   * this run's own project. Present on nested runs so a trace can be read
   * upwards, not only downwards through `subagentTraceId`.
   */
  ancestry?: string[];
  /**
   * The conversation the run belonged to, as `conversationKey` spells it —
   * `chat:{id}`, `slack:{channel}:{thread}`, `a2a:{client}:{contextId}`,
   * `api:{caller}:{id}`. Absent for a firing, and on traces written before
   * conversations existed. What lets the runs of one thread be found together.
   */
  conversation?: string;
  status: TraceStatus;
  spans: TraceSpan[];
  /** Spans dropped after the per-trace cap; absent when nothing was dropped. */
  spansDropped?: number;
  /**
   * Bindings the run could not use (a deleted skill, an unreachable MCP server).
   * The run still answered, so this is not an `error` — but the answer was
   * produced with less than the version declares, which is what makes an
   * otherwise puzzling trace readable.
   */
  warnings?: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  createdAt: string;
}
