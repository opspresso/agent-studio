/**
 * Row retention via DynamoDB TTL. Trace/usage/chat rows carry a unix-seconds
 * `expiresAt` attribute (the table's TTL attribute, shared with the Slack dedup
 * and Better Auth session/verification rows); expired rows are also filtered
 * out of reads because the physical purge
 * is only eventually consistent (up to ~48h). Retention windows are configurable
 * with safe defaults.
 */

const SECONDS_PER_DAY = 86_400;

function retentionDays(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const RETENTION = {
  /** Debug traces (sampled) — short-lived. */
  get traceDays(): number {
    return retentionDays("TRACE_RETENTION_DAYS", 30);
  },
  /** Cost/usage rows — kept well beyond the dashboard's 184-day query window. */
  get usageDays(): number {
    return retentionDays("USAGE_RETENTION_DAYS", 400);
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
   * Audit records — the longest window here, because the question they answer
   * ("who revealed that credential?") is usually asked long after the fact, and
   * a year is the shortest span that covers an annual review.
   */
  get auditDays(): number {
    return retentionDays("AUDIT_RETENTION_DAYS", 365);
  },
};

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
