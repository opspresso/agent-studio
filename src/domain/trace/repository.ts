import type { Trace } from "./types";

export interface ListTracesOptions {
  limit?: number;
  /** Inclusive lower bound on the trace date (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound on the trace date (YYYY-MM-DD). */
  to?: string;
}

export interface TraceRepository {
  put(trace: Trace): Promise<void>;
  get(traceId: string): Promise<Trace | null>;
  listByProject(projectName: string, options?: ListTracesOptions): Promise<Trace[]>;
}
