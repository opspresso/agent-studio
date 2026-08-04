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

/**
 * The instant a `YYYY-MM-DD` names, or `undefined` when it names no day.
 *
 * The shape check is not the same question as the calendar one, and only the
 * second is load-bearing here. `2026-13-01` parses to `NaN`, which would make
 * the range loop produce nothing and answer `200 {events: []}` — an audit reader
 * told "that is everything" by a query that never ran. `2026-02-31` is worse
 * still: it parses, to March 3rd, silently widening the range past the month
 * that was asked for. Round-tripping through {@link utcDay} is what rejects
 * both.
 */
function dayStart(day: string): number | undefined {
  if (!DAY.test(day)) {
    return undefined;
  }
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at) || utcDay(new Date(at)) !== day) {
    return undefined;
  }
  return at;
}

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
      const start = dayStart(from);
      const end = dayStart(to);
      if (start === undefined || end === undefined) {
        throw new ValidationError("from and to must be a real UTC day, as YYYY-MM-DD");
      }
      if (end < start) {
        throw new ValidationError("to must not be earlier than from");
      }
      // Counted, not enumerated. `daysInRange` allocates a Date and a string per
      // day, so a range of a few thousand years would spend seconds of the one
      // event loop and hundreds of megabytes before this line got to refuse it —
      // a rejected query that costs more than an accepted one is a way to take
      // the instance down through an endpoint that answers 400.
      const dayCount = Math.round((end - start) / MS_PER_DAY) + 1;
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
