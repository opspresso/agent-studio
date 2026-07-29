import type { UsageDelta, UsageRow } from "./types";

/** Which threshold a once-per-day notification belongs to. */
export type CostAlertKind = "alert" | "block";

export interface UsageRepository {
  /** Atomic ADD of one call's usage into the daily row. */
  record(delta: UsageDelta): Promise<void>;
  /**
   * One project's row for one date, or null when nothing was spent that day.
   * A single primary-key read — the cost guard runs it on every run, so it must
   * not become a query.
   */
  getDay(projectName: string, date: string): Promise<UsageRow | null>;
  /**
   * Claim the once-per-day notification for `kind`. Returns true for exactly one
   * caller per (project, date, kind) and false for every later one, including
   * across instances — it is a conditional write, not a read-then-write.
   *
   * The marker lives on the usage row rather than on the project item: the
   * project item's `updatedAt` is the optimistic-concurrency condition for
   * project updates, so a background write there would fail a concurrent edit.
   * The usage row is already updated atomically and expires on the usage date,
   * which takes the marker with it.
   */
  claimAlert(projectName: string, date: string, kind: CostAlertKind): Promise<boolean>;
  listByProject(projectName: string, from: string, to: string): Promise<UsageRow[]>;
  /** Cross-project rows for a date range (dashboard). */
  listByDateRange(from: string, to: string): Promise<UsageRow[]>;
}
