/** Triggers start runs using the Agent settings read when the firing is admitted. */

import type {
  MessageDestination,
  MessageDestinationKind,
} from "@/domain/messaging/destination";
import type { GitHubReviewConfig, PullRequestReviewTarget } from "./pullRequestReview";

/** The kinds a stored trigger row can be. */
export type TriggerKind = "webhook" | "schedule";

/**
 * The id an agent's own webhook is stored under.
 *
 * An agent has exactly one webhook, addressed by the agent name alone, so
 * nobody names it — the console turns it on and off. It is still a trigger row,
 * because everything a delivery needs already lives there: the secret, the
 * firing history, the idempotency claim, the overlap lease, the agent
 * cascade delete. Reserving one id is what buys all of that without a second
 * entity that would have to re-derive each of them.
 *
 * A schedule may not take this id (`triggerUseCases.create` refuses it); a
 * webhook row that predates this and happens to carry it simply *is* the
 * agent's webhook.
 */
export const AGENT_WEBHOOK_ID = "webhook";

/**
 * Where an agent's webhook is delivered — the single owner of that address.
 *
 * The console shows it, the API reference documents it, and the route serves
 * it; three spellings of one path is how a copied URL stops working.
 */
export function agentWebhookPath(agentName: string): string {
  return `/api/webhook/${agentName}`;
}

/** A destination that receives a schedule's completed text report. */
export type ScheduleDelivery = MessageDestination;

export type ScheduleDeliveryKind = MessageDestinationKind;

/** What happened when one destination was attempted after a schedule run. */
export interface ScheduleDeliveryResult {
  kind: ScheduleDeliveryKind;
  status: "sent" | "failed";
  error?: string;
}

/** What every trigger kind shares; each kind adds what only it needs. */
interface TriggerBase {
  agentName: string;
  /** Slug, unique within the agent; part of the delivery URL for webhooks. */
  triggerId: string;
  description: string;
  /** A disabled trigger never runs — a webhook's URL stays valid, a schedule's occurrences pass. */
  enabled: boolean;
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
  githubReview?: GitHubReviewConfig;
}

/**
 * Runs the current Agent configuration at cron occurrences. No secret and no payload:
 * nothing external presents credentials — the scan endpoint authenticates the
 * ticker itself — and every firing runs the same fixed input.
 */
export interface ScheduleTrigger extends TriggerBase {
  kind: "schedule";
  /** Captured from the authenticated owner when personal execution is explicitly enabled. */
  executionEmail?: string;
  /** Five-field cron expression, read in `timezone`. `src/domain/trigger/cron.ts` evaluates it. */
  cron: string;
  /** IANA zone the cron fields are read in, e.g. `Asia/Seoul`. */
  timezone: string;
  /** The user message each firing runs with; an agent needs one. */
  message?: string;
  /** Independently attempted after a successful run, at most once per platform. */
  deliveries?: ScheduleDelivery[];
}

export type Trigger = WebhookTrigger | ScheduleTrigger;

export type TriggerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  /** Refused before running: overlap not allowed, or no Agent configuration. */
  | "skipped";

export interface TriggerRun {
  agentName: string;
  triggerId: string;
  runId: string;
  status: TriggerRunStatus;
  /** The caller's `Idempotency-Key`, when one was sent. */
  idempotencyKey?: string;
  /** The UTC instant of the cron occurrence a schedule firing was claimed for. */
  scheduledFor?: string;
  /** Admission time for a queued schedule; runId remains its identity after dispatch. */
  queuedAt?: string;
  /** Queue owner's renewable lease, present only before dispatch. */
  queueLeaseUntil?: string;
  startedAt?: string;
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
  /** Per-destination outcome for a schedule report. */
  deliveryResults?: ScheduleDeliveryResult[];
  /** Set when the run was sampled into a trace, so the two can be joined. */
  traceId?: string;
  review?: PullRequestReviewTarget & {
    status: "posted" | "skipped" | "failed";
    url?: string;
    reason?: string;
  };
}
