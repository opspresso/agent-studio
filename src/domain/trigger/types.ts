/** Triggers start runs using the Agent settings read when the firing is admitted. */

import type {
  MessageDestination,
  MessageDestinationKind,
} from "@/domain/messaging/destination";
import type { GitHubReviewConfig, PullRequestReviewTarget } from "./pullRequestReview";
import type { RunUser } from "@/domain/execution/actor";

/** The kinds a stored trigger row can be. */
export type TriggerKind = "webhook" | "schedule";

/**
 * The id an agent's own webhook is stored under.
 *
 * An agent has exactly one webhook, addressed by the agent name alone, so
 * nobody names it — personal tokens control invocation. It is still a trigger row,
 * because delivery state lives there: the firing history, the idempotency claim, the overlap lease, the agent
 * cascade delete. Reserving one id is what buys all of that without a second
 * entity that would have to re-derive each of them.
 *
 * A schedule may not take this id (`triggerUseCases.create` refuses it).
 * Personal credentials select the caller, independently of this shared trigger.
 */
export const AGENT_WEBHOOK_ID = "webhook";
export const WEBHOOK_CREDENTIAL_QUERY = "credential";

/**
 * Where an agent's webhook is delivered — the single owner of that address.
 *
 * The console shows it, the API reference documents it, and the route serves
 * it; three spellings of one path is how a copied URL stops working.
 */
export function agentWebhookPath(agentName: string, credentialId?: string): string {
  const path = `/api/webhook/${encodeURIComponent(agentName)}`;
  return credentialId ? `${path}?${WEBHOOK_CREDENTIAL_QUERY}=${encodeURIComponent(credentialId)}` : path;
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
  githubReview?: GitHubReviewConfig;
}

/** Issuing a personal token initializes shared behavior only when no settings exist. */
export function defaultWebhookTrigger(agentName: string, createdAt: string): WebhookTrigger {
  return { agentName, triggerId: AGENT_WEBHOOK_ID, kind: "webhook", description: "", allowConcurrent: false, createdAt, updatedAt: createdAt };
}

/**
 * Runs the current Agent configuration at cron occurrences. No secret and no payload:
 * nothing external presents credentials — the scan endpoint authenticates the
 * ticker itself — and every firing runs the same fixed input.
 */
export interface ScheduleTrigger extends TriggerBase {
  kind: "schedule";
  /** Disabled schedules skip their occurrences; Webhooks use personal credential revocation. */
  enabled: boolean;
  /** Immutable registering user ID; email is a registration-time display snapshot. */
  createdBy: RunUser;
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
  /** The stable Studio caller captured when a firing is admitted. */
  userId?: string;
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
  /** Private execution ownership; renewal and terminal writes compare both values. */
  runningLeaseToken?: string;
  runningLeaseUntil?: string;
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
  /** Recorded execution Trace ID, for joining history to diagnostics. */
  traceId?: string;
  review?: PullRequestReviewTarget & {
    status: "posted" | "skipped" | "failed";
    url?: string;
    /** Prepared Workspace remains addressable on failed publication and after cleanup. */
    workspaceUrl?: string;
    reason?: string;
  };
}
