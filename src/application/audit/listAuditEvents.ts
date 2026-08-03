/**
 * Reading the audit log: a date range, assembled from the day partitions it
 * covers.
 *
 * The range is bounded because each day is its own Query — a caller asking for
 * a year would be asking for 365 of them. Bounding it here rather than at the
 * route keeps the reason with the key design that causes it.
 */

import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditEvent } from "@/domain/audit/types";
import { ValidationError } from "@/application/errors";
import { runBounded } from "@/shared/pool";
import { utcDay } from "@/shared/date";

/** Days one query may span. One Query per day, so this is a fan-out bound. */
export const MAX_AUDIT_RANGE_DAYS = 31;

/**
 * How many day partitions are read at once. The range bound above limits how
 * many days a caller may ask for; it says nothing about doing them all
 * simultaneously, and each one paginates until the partition is exhausted.
 */
const DAY_CONCURRENCY = 4;

/**
 * The most rows one read returns, **and the most any one day contributes**.
 *
 * `MAX_AUDIT_RANGE_DAYS` bounds the number of partitions, not their size, and
 * nothing bounds a partition: a row is written on every reveal, settings write,
 * deletion and ownership override, and they are kept for a year. Without this
 * the one read described as "rare" is the only unbounded one in the codebase.
 * Newest first, so what is dropped is the oldest end of the range — and the
 * caller is told, because a page that silently stops is a range that looks
 * empty before it was.
 *
 * It has to reach the query, not just the answer. A cap applied to the
 * assembled list still reads every row of every day into one array first, so
 * the bill is paid before the slice throws the rows away — thirty-one busy
 * partitions is a heap the pod does not have. Each day may contribute at most
 * the whole cap, because on a range where one day holds everything that is
 * exactly the answer.
 */
export const MAX_AUDIT_EVENTS = 2_000;

const DAY_MS = 86_400_000;

export interface AuditQuery {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
}

function parseDay(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} is not a date`);
  }
  return parsed;
}

/** The UTC days a range covers, oldest first. */
export function daysInRange(query: AuditQuery): string[] {
  const from = parseDay(query.from, "from");
  const to = parseDay(query.to, "to");
  if (from.getTime() > to.getTime()) {
    throw new ValidationError("from must not be after to");
  }
  const span = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (span > MAX_AUDIT_RANGE_DAYS) {
    throw new ValidationError(`Range must not exceed ${MAX_AUDIT_RANGE_DAYS} days`);
  }
  return Array.from({ length: span }, (_, index) => utcDay(new Date(from.getTime() + index * DAY_MS)));
}

export interface AuditPage {
  /** Newest first, capped at {@link MAX_AUDIT_EVENTS}. */
  events: AuditEvent[];
  /** True when the range held more than the cap; the oldest end was dropped. */
  truncated: boolean;
}

/** Every event in the range, newest first, bounded in fan-out and in size. */
export async function listAuditEvents(
  repo: AuditRepository,
  query: AuditQuery,
): Promise<AuditPage> {
  const days = daysInRange(query);
  const pages = await runBounded(days, DAY_CONCURRENCY, (day) =>
    repo.listByDay(day, MAX_AUDIT_EVENTS),
  );
  const all = pages.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // A day that came back full is a day that had more, whether or not the
  // assembled range exceeds the cap — so both count as truncated. Saying
  // otherwise would report a complete range that is missing its oldest rows.
  const dayFilled = pages.some((page) => page.length >= MAX_AUDIT_EVENTS);
  return {
    events: all.slice(0, MAX_AUDIT_EVENTS),
    truncated: dayFilled || all.length > MAX_AUDIT_EVENTS,
  };
}
