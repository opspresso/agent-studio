/**
 * Triggers: something outside the console starting a run.
 *
 * A trigger always runs the project's **published** version. A draft is
 * configuration in progress; an external system firing at one would run
 * whatever an editor happened to have saved, which is the same reason Slack and
 * A2A are published-only (`resolveRunnableVersion`).
 */

/** The kinds a stored trigger row can be. */
export type TriggerKind = "webhook" | "schedule";

/**
 * The id a project's own webhook is stored under.
 *
 * A project has exactly one webhook, addressed by the project name alone, so
 * nobody names it — the console turns it on and off. It is still a trigger row,
 * because everything a delivery needs already lives there: the secret, the
 * firing history, the idempotency claim, the overlap lease, the project
 * cascade delete. Reserving one id is what buys all of that without a second
 * entity that would have to re-derive each of them.
 *
 * A schedule may not take this id (`triggerUseCases.create` refuses it); a
 * webhook row that predates this and happens to carry it simply *is* the
 * project's webhook.
 */
export const PROJECT_WEBHOOK_ID = "webhook";

/**
 * Where a project's webhook is delivered — the single owner of that address.
 *
 * The console shows it, the API reference documents it, and the route serves
 * it; three spellings of one path is how a copied URL stops working.
 */
export function projectWebhookPath(projectName: string): string {
  return `/api/webhook/${projectName}`;
}

/** How a delivery's payload reaches the run. */
export type TriggerPayloadMode =
  /**
   * The payload's top-level string fields become template variables, under the
   * trigger's own fixed ones. Only a prompt project consumes variables.
   */
  | "variables"
  /** The payload is serialised into the user message. What an agent project wants. */
  | "message";

/** What every trigger kind shares; each kind adds what only it needs. */
interface TriggerBase {
  projectName: string;
  /** Slug, unique within the project; part of the delivery URL for webhooks. */
  triggerId: string;
  description: string;
  /** A disabled trigger never runs — a webhook's URL stays valid, a schedule's occurrences pass. */
  enabled: boolean;
  /** Fixed variables every run starts from. */
  variables?: Record<string, string>;
  /**
   * Whether a firing may start while a run from this trigger is still going.
   * False is the safer default — a webhook that fires faster than the run takes
   * (or a schedule tighter than its run) would otherwise pile runs up until the
   * cost guard notices.
   */
  allowConcurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookTrigger extends TriggerBase {
  kind: "webhook";
  /** AES-encrypted at rest, masked on read, compared in constant time. */
  secret: string;
  payloadMode: TriggerPayloadMode;
}

/**
 * Fires the published version at cron occurrences. No secret and no payload:
 * nothing external presents credentials — the scan endpoint authenticates the
 * ticker itself — and every firing runs the same fixed input.
 */
export interface ScheduleTrigger extends TriggerBase {
  kind: "schedule";
  /** Five-field cron expression, read in `timezone`. `src/domain/trigger/cron.ts` evaluates it. */
  cron: string;
  /** IANA zone the cron fields are read in, e.g. `Asia/Seoul`. */
  timezone: string;
  /** The user message each firing runs with; an agent project needs one. */
  message?: string;
}

export type Trigger = WebhookTrigger | ScheduleTrigger;

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
  /** The UTC instant of the cron occurrence a schedule firing was claimed for. */
  scheduledFor?: string;
  startedAt: string;
  endedAt?: string;
  /** Bounded preview of the answer — a run's whole output does not belong here. */
  result?: string;
  error?: string;
  /**
   * What the run reported without failing — a turn or budget limit it hit, a
   * binding it could not use. Without this a firing the turn guard ended was a
   * green `succeeded` row while its own trace said `turn-limit`, and an
   * unattended surface has nobody watching the stream to notice.
   */
  warning?: string;
  /** Set when the run was sampled into a trace, so the two can be joined. */
  traceId?: string;
}
