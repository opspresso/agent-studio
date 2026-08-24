/**
 * Reading the audit trail. Admin-only at the route, because the rows name who
 * did what and a shared catalog is not a shared conscience.
 */

import { ValidationError } from "@/application/errors";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditEvent } from "@/domain/audit/types";
import { daySpan, daysBetween, isUtcDay } from "@/shared/date";

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


/**
 * Every UTC day from `from` to `to`, inclusive, newest first.
 *
 * The direction is this reader's — an audit is read from what just happened
 * backwards — and it is all that is this reader's: the walk itself is shared
 * with the usage rows and the cost chart, which read the other way.
 */
export function daysInRange(from: string, to: string): string[] {
  return daysBetween(from, to).reverse();
}

export interface AuditUseCases {
  list(query: AuditQuery): Promise<AuditEvent[]>;
}

export function createAuditUseCases(repo: AuditRepository): AuditUseCases {
  return {
    async list(query) {
      const from = query.from;
      const to = query.to ?? from;
      // The shape check is not the same question as the calendar one, and only
      // the second is load-bearing here: `2026-13-01` would make the range walk
      // produce nothing and answer `200 {events: []}` — an audit reader told
      // "that is everything" by a query that never ran — and `2026-02-31` would
      // silently widen the range past the month that was asked for. `isUtcDay`
      // owns the distinction.
      if (!isUtcDay(from) || !isUtcDay(to)) {
        throw new ValidationError("from and to must be a real UTC day, as YYYY-MM-DD");
      }
      // Both are days the calendar has, and `YYYY-MM-DD` sorts the way the
      // calendar does — the same comparison the usage range makes, rather than
      // a second pair of instants to keep in step with the walk below.
      if (to < from) {
        throw new ValidationError("to must not be earlier than from");
      }
      // Counted, not enumerated. `daysInRange` allocates a Date and a string per
      // day, so a range of a few thousand years would spend seconds of the one
      // event loop and hundreds of megabytes before this line got to refuse it —
      // a rejected query that costs more than an accepted one is a way to take
      // the instance down through an endpoint that answers 400.
      const dayCount = daySpan(from, to);
      if (dayCount > MAX_AUDIT_RANGE_DAYS) {
        throw new ValidationError(
          `A query may span at most ${MAX_AUDIT_RANGE_DAYS} days; asked for ${dayCount}`,
        );
      }
      const days = daysInRange(from, to);
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
