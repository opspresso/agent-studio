import type { Trace } from "./types";
import type { RunActorKind } from "@/domain/execution/actor";

export interface ListTracesOptions {
  limit?: number;
  /** Inclusive lower bound on the trace date (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound on the trace date (YYYY-MM-DD). */
  to?: string;
  /** Filter before the page limit so other surfaces cannot hide this history. */
  actorKind?: RunActorKind;
}

export interface TraceRepository {
  put(trace: Trace): Promise<void>;
  get(traceId: string): Promise<Trace | null>;
  listByAgent(agentName: string, options?: ListTracesOptions): Promise<Trace[]>;
}
