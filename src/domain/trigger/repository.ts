import type { ScheduleTrigger, Trigger, TriggerRun } from "./types";

export interface TriggerRepository {
  get(agentName: string, triggerId: string): Promise<Trigger | null>;
  listByAgent(agentName: string, limit: number, after?: string): Promise<Trigger[]>;
  /** One page of every agent's schedule triggers — the rows a scan tick walks. */
  listSchedules(
    limit: number,
    after?: { agentName: string; triggerId: string },
  ): Promise<ScheduleTrigger[]>;
  /** Create; fails if the id is taken within the agent. */
  create(trigger: Trigger): Promise<void>;
  put(trigger: Trigger): Promise<void>;
  delete(agentName: string, triggerId: string): Promise<void>;

  /**
   * Claim a firing's dedup key: a delivery's `Idempotency-Key`, or a schedule
   * occurrence's `schedule:{UTC instant}`. One caller wins per
   * (agent, trigger, key) while its claim row exists; false for a redelivery or
   * a slot another instance already claimed. Expiry does not unblock the key
   * until retention deletes the row.
   *
   * A conditional write rather than a read-then-write, because the whole point
   * is the case where the same key arrives at two instances at once.
   */
  claimIdempotencyKey(agentName: string, triggerId: string, key: string): Promise<boolean>;

  appendRun(run: TriggerRun): Promise<void>;
  /** Finish a run in place — the row was written when it started. */
  finishRun(run: TriggerRun): Promise<void>;
  /** Atomically renew, start or close this exact queued lease; a stale owner cannot dispatch. */
  updateQueuedRun(previous: TriggerRun, next: TriggerRun): Promise<boolean>;
  /** Renew or settle the exact running owner; repair uses the same token/deadline CAS. */
  updateRunningRun(previous: TriggerRun, next: TriggerRun, options?: { requireLiveOwner?: boolean }): Promise<boolean>;
  /**
   * Most recent history first. Owner repair reads use their lease index instead.
   *
   * `startedBefore` narrows the window to rows that started before that instant.
   * The console wants the newest N; a repair sweep wants the newest N *that are
   * old enough to be dead*. `status` filters before the limit so completed runs
   * cannot hide stranded ones. On a trigger taking ten deliveries a minute
   * those are not the same rows — a firing stranded twenty minutes ago sits
   * under two hundred newer ones and would never appear in an unbounded page.
   * `queueLeaseBefore` applies to the queued lease index before its limit.
   * `runningLeaseBefore` applies to the running owner lease index; `unownedRunning`
   * selects only history without a running owner token before its limit.
   */
  listRuns(
    agentName: string,
    triggerId: string,
    limit: number,
    opts?: { startedBefore?: string; queueLeaseBefore?: string; runningLeaseBefore?: string; unownedRunning?: boolean; status?: TriggerRun["status"] },
  ): Promise<TriggerRun[]>;
}
