import type { Trace } from "./types";

export interface TraceRepository {
  put(trace: Trace): Promise<void>;
  get(traceId: string): Promise<Trace | null>;
  listByProject(projectName: string, limit?: number): Promise<Trace[]>;
}
