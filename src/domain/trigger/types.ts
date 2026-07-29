/**
 * Triggers: something outside the console starting a run.
 *
 * A trigger always runs the project's **published** version. A draft is
 * configuration in progress; an external system firing at one would run
 * whatever an editor happened to have saved, which is the same reason Slack and
 * A2A are published-only (`resolveRunnableVersion`).
 */

/** The kinds a stored trigger row can be. `schedule` is not implemented yet. */
export type TriggerKind = "webhook";

/** How a delivery's payload reaches the run. */
export type TriggerPayloadMode =
  /**
   * The payload's top-level string fields become template variables, under the
   * trigger's own fixed ones. Only a prompt project consumes variables.
   */
  | "variables"
  /** The payload is serialised into the user message. What an agent project wants. */
  | "message";

export interface WebhookTrigger {
  projectName: string;
  /** Slug, unique within the project; part of the delivery URL. */
  triggerId: string;
  kind: TriggerKind;
  description: string;
  /** A disabled trigger accepts nothing — the URL stays valid but never runs. */
  enabled: boolean;
  /** AES-encrypted at rest, masked on read, compared in constant time. */
  secret: string;
  /** Fixed variables every delivery starts from; the payload layers over them. */
  variables?: Record<string, string>;
  payloadMode: TriggerPayloadMode;
  /**
   * Whether a delivery may start while a run from this trigger is still going.
   * False is the safer default — a webhook that fires faster than the run takes
   * would otherwise pile runs up until the cost guard notices.
   */
  allowConcurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TriggerRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  /** Refused before running: overlap not allowed, or no published version. */
  | "skipped";

export interface TriggerRun {
  projectName: string;
  triggerId: string;
  runId: string;
  status: TriggerRunStatus;
  /** The caller's `Idempotency-Key`, when one was sent. */
  idempotencyKey?: string;
  startedAt: string;
  endedAt?: string;
  /** Bounded preview of the answer — a run's whole output does not belong here. */
  result?: string;
  error?: string;
  /** Set when the run was sampled into a trace, so the two can be joined. */
  traceId?: string;
}
