/**
 * Audit records, one partition per UTC day.
 *
 * Append-only: nothing in the app updates or deletes a row, and expiry is the
 * store's sweep rather than a code path. That is the point — a record whose
 * subject can erase it is not a record. It also means an agent's cascade delete
 * leaves its audit rows standing, which is exactly what makes "who deleted this
 * agent" answerable at all.
 */

import { keys } from "@/infrastructure/db/keys";
import { putItem, queryItems } from "@/infrastructure/db/store";
import { expiresAtSeconds, RETENTION } from "@/infrastructure/db/ttl";
import { utcDay } from "@/shared/date";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditAction, AuditEvent } from "@/domain/audit/types";
import { boundedPageLimit } from "@/shared/pageLimit";

const AUDIT_ENTITY = "AuditEvent";

function toEvent(item: Record<string, unknown>): AuditEvent {
  return {
    eventId: String(item.eventId ?? ""),
    actorEmail: String(item.actorEmail ?? ""),
    action: item.action as AuditAction,
    target: String(item.target ?? ""),
    ...(item.detail ? { detail: String(item.detail) } : {}),
    createdAt: String(item.createdAt ?? ""),
  };
}

export const auditRepository: AuditRepository = {
  async append(event) {
    const day = utcDay(new Date(event.createdAt));
    await putItem({
      ...keys.auditEvent(day, event.createdAt, event.eventId),
      ...event,
      entityType: AUDIT_ENTITY,
      expiresAt: expiresAtSeconds(event.createdAt, RETENTION.auditDays),
    });
  },

  async listByDay(day, limit, after) {
    const items = await queryItems({
      pk: keys.auditDayPartition(day),
      forward: false,
      limit: boundedPageLimit(limit),
      ...(after ? { after: keys.auditEvent(day, after.createdAt, after.eventId).SK } : {}),
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map((item) => {
      const event = toEvent(item);
      if (keys.auditEvent(day, event.createdAt, event.eventId).SK !== item.SK) {
        throw new Error("audit event identity does not match its key");
      }
      return event;
    });
  },
};
