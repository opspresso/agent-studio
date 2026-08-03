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
import { utcDay } from "@/shared/date";

/** Days one query may span. One Query per day, so this is a fan-out bound. */
export const MAX_AUDIT_RANGE_DAYS = 31;

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

/** Every event in the range, newest first. */
export async function listAuditEvents(
  repo: AuditRepository,
  query: AuditQuery,
): Promise<AuditEvent[]> {
  const days = daysInRange(query);
  const pages = await Promise.all(days.map((day) => repo.listByDay(day)));
  return pages.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
