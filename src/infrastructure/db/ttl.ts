/**
 * Row retention via DynamoDB TTL. Trace/usage/chat rows carry a unix-seconds
 * `expiresAt` attribute (the table's TTL attribute, shared with the Slack dedup
 * and Better Auth session/verification rows); expired rows are also filtered
 * out of reads because the physical purge
 * is only eventually consistent (up to ~48h). Retention windows are configurable
 * with safe defaults.
 */

import { positiveIntEnv } from "@/lib/config";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";

const SECONDS_PER_DAY = 86_400;

/**
 * Through `config`, which owns the parse and the warning — and dedupes it, which
 * matters here: these are getters read on every row write, once per model call
 * for usage. Zero is not a window, so the floor is one day rather than none.
 */
function retentionDays(envVar: string, fallback: number): number {
  return positiveIntEnv(envVar, fallback, 1);
}

export const RETENTION = {
  /** Debug traces (sampled) — short-lived. */
  get traceDays(): number {
    return retentionDays("TRACE_RETENTION_DAYS", 30);
  },
  /**
   * Cost/usage rows — kept well beyond the dashboard's 184-day query window.
   * The floor is a full month, not a day: the monthly cost guard sums the
   * month's daily rows, and a shorter window would silently under-count spend
   * late in the month until the block never fired.
   */
  get usageDays(): number {
    return positiveIntEnv("USAGE_RETENTION_DAYS", 400, 31);
  },
  /** Chats and their messages, measured from last activity. */
  get chatDays(): number {
    return retentionDays("CHAT_RETENTION_DAYS", 180);
  },
  /** Trigger delivery history — an operational log, not a record to keep. */
  get triggerRunDays(): number {
    return retentionDays("TRIGGER_RUN_RETENTION_DAYS", 30);
  },
  /** Inbound A2A task state — ephemeral job state, kept just long enough for
   * `tasks/get`/`tasks/cancel` after `message/send`. */
  get a2aTaskDays(): number {
    return retentionDays("A2A_TASK_RETENTION_DAYS", 1);
  },
  /**
   * Artifact rows — the inventory of what runs produced.
   *
   * Matched to chats by default because that is already the effective lifetime
   * of a generated image: the deployment checklist points the bucket's
   * lifecycle rule at `CHAT_RETENTION_DAYS`. Shorter than chats and an image
   * still visible in a conversation disappears from its own gallery first;
   * longer, and the gallery lists rows whose bytes the bucket already swept.
   * The row TTL and the bucket rule are two independent settings and the app
   * cannot enforce agreement — see docs/OPERATIONS.md.
   */
  get artifactDays(): number {
    return retentionDays("ARTIFACT_RETENTION_DAYS", 180);
  },
  /**
   * Audit records. As long as usage by default, and the longest here with it:
   * the question these answer — who changed the admin list, who revealed that
   * credential — is asked long after the fact, and unlike a trace the row is
   * small and one per sensitive act rather than one per run.
   */
  get auditDays(): number {
    return retentionDays("AUDIT_RETENTION_DAYS", 400);
  },
};

/**
 * How long a chat run's replay log lives.
 *
 * Not a retention window like the ones above — nothing is kept here, it is a
 * buffer a disconnected reader catches up from. Derived from the run lease so
 * the log always outlives the run that writes it: a log expiring first would
 * leave a resume with a hole in the middle of a run still in progress. The
 * margin past it is how long after the answer someone may still reopen the tab
 * and watch the tail rather than reading the finished message.
 */
export const RUN_LOG_TTL_SECONDS = RUN_LEASE_SECONDS + 15 * 60;

/**
 * How long the bot stays engaged in a channel thread it answered in.
 *
 * Not retention — it is the feature. Inside this window a follow-up in that
 * thread needs no mention; past it, one is required again. A day, refreshed on
 * every reply: within a working day picking a conversation back up without
 * re-addressing the bot is how people actually talk, and by the next day a
 * mention is a reasonable thing to ask for. Fixed rather than configurable,
 * because there is no evidence yet that would tell an operator what to set it
 * to.
 */
export const SLACK_ENGAGEMENT_TTL_SECONDS = SECONDS_PER_DAY;

/**
 * How long a remote agent's `contextId` is kept for one of our conversations.
 *
 * Not retention either — past it, the next transfer from that conversation
 * starts the remote conversation over, which is what every transfer did before
 * the row existed. A week rather than the engagement day above: a chat is
 * picked back up days later where a Slack thread rarely is, and the cost of a
 * stale hint is one cold start, not a wrong answer. Refreshed on every
 * transfer, so a live conversation never expires mid-life.
 */
export const REMOTE_CONVERSATION_TTL_SECONDS = 7 * SECONDS_PER_DAY;

/**
 * How long a conversation transcript's turns are kept, for a surface whose
 * platform hands back no history (Telegram).
 *
 * The same week as the remote-conversation hint above, for the same reason: a
 * Telegram chat is picked back up days later, and past a week a follow-up that
 * has lost its context costs one restatement of the question, not a wrong
 * answer. Per turn rather than per conversation, so a live conversation keeps
 * its recent turns while its old ones expire underneath.
 */
export const TRANSCRIPT_TTL_SECONDS = 7 * SECONDS_PER_DAY;

/** Unix-seconds TTL: `retentionDays` after `baseIso`. Falls back to now for an
 * unparseable base so a row is never written without an expiry. */
export function expiresAtSeconds(baseIso: string, retentionDays: number): number {
  const parsed = Date.parse(baseIso);
  const baseMs = Number.isNaN(parsed) ? Date.now() : parsed;
  return Math.floor(baseMs / 1000) + retentionDays * SECONDS_PER_DAY;
}

/**
 * Unix-seconds TTL a fixed number of seconds from `nowMs`. For rows whose life
 * is measured in minutes — an OAuth authorization in flight — where the
 * day-granular helper above cannot express the window. Kept here so every TTL
 * this table writes is still computed in one place.
 */
export function expiresAtFromNow(seconds: number, nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + seconds;
}

/**
 * Unix-seconds TTL for a row whose expiry is already fixed as an ISO instant
 * rather than derived from a retention window — the Better Auth session and
 * verification rows, whose lifetime the auth library decides. Returns undefined
 * for an unparseable value: better to leave the row without a TTL than to write
 * a NaN the put would reject or a 1970 timestamp that deletes it immediately.
 */
export function expiresAtFromIso(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

/** True once the row's TTL has passed. Absent `expiresAt` never expires. */
export function isExpired(expiresAt: unknown, nowMs: number): boolean {
  return typeof expiresAt === "number" && expiresAt * 1000 <= nowMs;
}

/** Drop rows whose TTL has already passed (physical purge lags). */
export function notExpired<T extends Record<string, unknown>>(items: T[], nowMs: number): T[] {
  return items.filter((item) => !isExpired(item.expiresAt, nowMs));
}
