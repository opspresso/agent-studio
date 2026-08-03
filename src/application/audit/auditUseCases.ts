/**
 * Reading the audit trail. Admin-only at the route, because the rows name who
 * did what and a shared catalog is not a shared conscience.
 */

import { ValidationError } from "@/application/errors";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditEvent } from "@/domain/audit/types";
import { utcDay } from "@/shared/date";

/**
 * How many days one query may span. A range is read a partition at a time, so
 * this is the query count as much as the result size — and the window a person
 * actually asks about ("last week", "that Tuesday") fits inside it comfortably.
 */
export const MAX_AUDIT_RANGE_DAYS = 31;

export interface AuditQuery {
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive UTC day, `YYYY-MM-DD`. Defaults to `from`. */
  to?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Every UTC day from `from` to `to`, inclusive, newest first. */
export function daysInRange(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let at = end; at >= start; at -= MS_PER_DAY) {
    days.push(utcDay(new Date(at)));
  }
  return days;
}

export interface AuditUseCases {
  list(query: AuditQuery): Promise<AuditEvent[]>;
}

export function createAuditUseCases(repo: AuditRepository): AuditUseCases {
  return {
    async list(query) {
      const from = query.from;
      const to = query.to ?? from;
      if (!DAY.test(from) || !DAY.test(to)) {
        throw new ValidationError("from and to must be YYYY-MM-DD (UTC)");
      }
      if (to < from) {
        throw new ValidationError("to must not be earlier than from");
      }
      const days = daysInRange(from, to);
      if (days.length > MAX_AUDIT_RANGE_DAYS) {
        throw new ValidationError(
          `A query may span at most ${MAX_AUDIT_RANGE_DAYS} days; asked for ${days.length}`,
        );
      }
      // Sequential rather than concurrent: this is an admin screen nobody loads
      // in a loop, and a month of partitions fanned out at once is a burst the
      // table sees for no gain in a page a person reads.
      const events: AuditEvent[] = [];
      for (const day of days) {
        events.push(...(await repo.listByDay(day)));
      }
      return events;
    },
  };
}
