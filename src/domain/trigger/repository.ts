import type { ScheduleTrigger, Trigger, TriggerRun } from "./types";

export interface TriggerRepository {
  get(projectName: string, triggerId: string): Promise<Trigger | null>;
  listByProject(projectName: string, limit: number, after?: string): Promise<Trigger[]>;
  /** One page of every project's schedule triggers — the rows a scan tick walks. */
  listSchedules(
    limit: number,
    after?: { projectName: string; triggerId: string },
  ): Promise<ScheduleTrigger[]>;
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
  /**
   * Most recent runs first.
   *
   * `startedBefore` narrows the window to rows that started before that instant.
   * The console wants the newest N; a repair sweep wants the newest N *that are
   * old enough to be dead*. `status` filters before the limit so completed runs
   * cannot hide stranded ones. On a trigger taking ten deliveries a minute
   * those are not the same rows — a firing stranded twenty minutes ago sits
   * under two hundred newer ones and would never appear in an unbounded page.
   */
  listRuns(
    projectName: string,
    triggerId: string,
    limit: number,
    opts?: { startedBefore?: string; status?: TriggerRun["status"] },
  ): Promise<TriggerRun[]>;
}
