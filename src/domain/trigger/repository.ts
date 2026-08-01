import type { ScheduleTrigger, Trigger, TriggerRun } from "./types";

export interface TriggerRepository {
  get(projectName: string, triggerId: string): Promise<Trigger | null>;
  listByProject(projectName: string): Promise<Trigger[]>;
  /** Every project's schedule triggers — the rows a scan tick walks. */
  listSchedules(): Promise<ScheduleTrigger[]>;
  /** Create; fails if the id is taken within the project. */
  create(trigger: Trigger): Promise<void>;
  put(trigger: Trigger): Promise<void>;
  delete(projectName: string, triggerId: string): Promise<void>;

  /**
   * Claim a firing's dedup key: a delivery's `Idempotency-Key`, or a schedule
   * occurrence's `schedule:{UTC instant}`. True exactly once per
   * (project, trigger, key); false for a redelivery or a slot another instance
   * already claimed.
   *
   * A conditional write rather than a read-then-write, because the whole point
   * is the case where the same key arrives at two instances at once.
   */
  claimIdempotencyKey(projectName: string, triggerId: string, key: string): Promise<boolean>;

  appendRun(run: TriggerRun): Promise<void>;
  /** Finish a run in place — the row was written when it started. */
  finishRun(run: TriggerRun): Promise<void>;
  /** Most recent runs first. */
  listRuns(projectName: string, triggerId: string, limit: number): Promise<TriggerRun[]>;
}
