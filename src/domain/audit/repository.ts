import type { AuditEvent } from "./types";

export interface AuditRepository {
  /** Append one record. Rows are never updated or deleted by the app. */
  append(event: AuditEvent): Promise<void>;
  /**
   * One UTC day's records, newest first. A range is read a day at a time, the
   * same shape the cost dashboard uses over `USAGEDATE#` — it keeps the write
   * path spread across partitions instead of appending every row of the
   * deployment's history to one.
   */
  listByDay(day: string): Promise<AuditEvent[]>;
}
