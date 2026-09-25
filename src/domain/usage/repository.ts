import type { ActorUsageRow, MemberUsageRow, UsageDelta, UsageRow } from "./types";

/** Which threshold a once-per-day notification belongs to. */
export type CostAlertKind = "alert" | "block";

export interface UsageRepository {
  /**
   * Atomic ADD of one call's usage into the daily row, and into the caller's
   * own daily row when the delta names one. The agent total is written first
   * and unconditionally: attribution must never be the reason spend goes
   * unrecorded.
   */
  record(delta: UsageDelta): Promise<void>;
  /** One agent's per-caller rows across a date range (who spent it). */
  listActorsByAgent(
    agentName: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<ActorUsageRow[]>;
  /**
   * One agent's row for one date, or null when nothing was spent that day.
   * A single primary-key read — the cost guard runs it on every run, so it must
   * not become a query.
   */
  getDay(agentName: string, date: string): Promise<UsageRow | null>;
  /**
   * One member's own daily rows across a date range — the tier cap's window
   * and the profile page's, read the same way. Bounded pages in that member's
   * own partition, like `listByAgent`.
   */
  listMemberDays(email: string, from: string, to: string): Promise<MemberUsageRow[]>;
  /**
   * Claim the once-per-day notification for `kind`. Returns true for exactly one
   * caller per (agent, date, kind) and false for every later one, including
   * across instances — it is a conditional write, not a read-then-write.
   *
   * The marker lives on the usage row rather than on the agent item: the
   * agent item's `updatedAt` is the optimistic-concurrency condition for
   * agent updates, so a background write there would fail a concurrent edit.
   * The usage row is already updated atomically and expires on the usage date,
   * which takes the marker with it.
   */
  claimAlert(agentName: string, date: string, kind: CostAlertKind): Promise<boolean>;
  /**
   * The monthly counterpart of `claimAlert`, on its own `MONTHCLAIM#{yyyy-MM}`
   * row rather than a marker on a daily row: a marker claimed on the day the
   * threshold was crossed would let an instance running on a later day claim
   * again, because it reads a different row.
   */
  claimMonthAlert(agentName: string, month: string, kind: CostAlertKind): Promise<boolean>;
  listByAgent(agentName: string, from: string, to: string): Promise<UsageRow[]>;
  /** Cross-agent rows for a date range (dashboard). */
  listByDateRange(from: string, to: string): Promise<UsageRow[]>;
}
