/**
 * Reading the audit trail. Admin-only at the route, because the rows name who
 * did what and a shared catalog is not a shared conscience.
 */

import { ValidationError } from "@/application/errors";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditEvent } from "@/domain/audit/types";
import { daySpan, daysBetween, isUtcDay } from "@/shared/date";
import { boundedPageLimit } from "@/shared/pageLimit";

/**
 * How many days one query may span. A range is read a partition at a time, so
 * this is the query count as much as the result size — and the window a person
 * actually asks about ("last week", "that Tuesday") fits inside it comfortably.
 */
export const MAX_AUDIT_RANGE_DAYS = 31;
/** Leave one repository slot to probe for another event without buffering a full day. */
export const AUDIT_PAGE_SIZE = 50;

interface AuditCursor {
  day: string;
  createdAt: string;
  eventId: string;
}

function encodeCursor(day: string, event: AuditEvent): string {
  return Buffer.from(JSON.stringify([day, event.createdAt, event.eventId])).toString("base64url");
}

function decodeCursor(raw: string): AuditCursor {
  const invalid = (): never => { throw new ValidationError("Invalid audit cursor"); };
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { invalid(); }
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== "string") ||
      Buffer.from(JSON.stringify(value)).toString("base64url") !== raw) invalid();
  const [day, createdAt, eventId] = value as [string, string, string];
  const instant = Date.parse(createdAt);
  if (!day || !createdAt || !eventId || !isUtcDay(day) || eventId.length > 128 ||
      !createdAt.startsWith(`${day}T`) || !Number.isFinite(instant) ||
      new Date(instant).toISOString() !== createdAt) invalid();
  return { day, createdAt, eventId };
}

export interface AuditQuery {
  /** Inclusive UTC day, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive UTC day, `YYYY-MM-DD`. Defaults to `from`. */
  to?: string;
  /** Opaque position returned by the previous page of this date range. */
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  events: AuditEvent[];
  nextCursor: string | null;
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
  list(query: AuditQuery): Promise<AuditPage>;
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
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      const firstDay = cursor ? days.indexOf(cursor.day) : 0;
      if (firstDay < 0) throw new ValidationError("Audit cursor is outside the requested date range");
      const limit = boundedPageLimit(query.limit ?? AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);
      const collected: Array<{ day: string; event: AuditEvent }> = [];
      // A page needs at most one extra event to prove there is more. Read days
      // sequentially and stop as soon as that probe succeeds.
      for (const day of days.slice(firstDay)) {
        const after = cursor && day === cursor.day
          ? { createdAt: cursor.createdAt, eventId: cursor.eventId } : undefined;
        const page = await repo.listByDay(day, limit + 1 - collected.length, after);
        collected.push(...page.map((event) => ({ day, event })));
        if (collected.length > limit) break;
      }
      const entries = collected.slice(0, limit);
      const last = entries.at(-1);
      return {
        events: entries.map(({ event }) => event),
        nextCursor: collected.length > limit && last ? encodeCursor(last.day, last.event) : null,
      };
    },
  };
}
