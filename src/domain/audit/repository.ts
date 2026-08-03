import type { AuditEvent } from "./types";

export interface AuditRepository {
  /** Append one event. Rows are immutable — nothing updates or deletes them. */
  append(event: AuditEvent): Promise<void>;
  /**
   * One UTC day's events, newest first, at most `limit` of them.
   *
   * A day at a time because that is how the rows are partitioned: an audit log
   * is written constantly and read rarely, so the key is chosen for a bounded
   * write partition rather than for a range scan, and a reader assembles the
   * range it wants from the days in it.
   *
   * The limit is part of the port rather than the caller's slice because a
   * write partition bounded for *writing* is not bounded for reading: nothing
   * caps how many rows a busy day holds, and a reader that collects them all
   * before discarding most has already paid for them. Newest first, so the
   * limit takes the end a reader asked for.
   */
  listByDay(day: string, limit?: number): Promise<AuditEvent[]>;
}
