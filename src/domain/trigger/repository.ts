import type { TriggerRun, WebhookTrigger } from "./types";

export interface TriggerRepository {
  get(projectName: string, triggerId: string): Promise<WebhookTrigger | null>;
  listByProject(projectName: string): Promise<WebhookTrigger[]>;
  /** Create; fails if the id is taken within the project. */
  create(trigger: WebhookTrigger): Promise<void>;
  put(trigger: WebhookTrigger): Promise<void>;
  delete(projectName: string, triggerId: string): Promise<void>;

  /**
   * Claim a delivery's `Idempotency-Key`. True exactly once per
   * (project, trigger, key); false for a redelivery.
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
