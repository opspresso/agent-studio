import type { AuditEvent } from "./types";

export interface AuditRepository {
  /** Append one event. Rows are immutable — nothing updates or deletes them. */
  append(event: AuditEvent): Promise<void>;
  /**
   * One UTC day's events, newest first.
   *
   * A day at a time because that is how the rows are partitioned: an audit log
   * is written constantly and read rarely, so the key is chosen for a bounded
   * write partition rather than for a range scan, and a reader assembles the
   * range it wants from the days in it.
   */
  listByDay(day: string): Promise<AuditEvent[]>;
}
