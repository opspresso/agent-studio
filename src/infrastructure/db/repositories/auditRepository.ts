/**
 * Audit rows: append-only, partitioned by UTC day, TTL'd by
 * `AUDIT_RETENTION_DAYS`.
 *
 * No update path and no delete path, deliberately. A record of who did what is
 * worth nothing if the person it names can edit it, and the only thing that
 * removes one is the retention window the deployment configured.
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { queryAll } from "@/infrastructure/db/query";
import { keys } from "@/infrastructure/db/keys";
import { currentTenant } from "@/shared/tenantContext";
import { notExpired, RETENTION, expiresAtSeconds } from "@/infrastructure/db/ttl";
import { utcDay } from "@/shared/date";
import type { AuditRepository } from "@/domain/audit/repository";
import type { AuditAction, AuditEvent } from "@/domain/audit/types";

const ENTITY = "AuditEvent";

function toEvent(item: Record<string, unknown>): AuditEvent {
  return {
    id: String(item.id ?? ""),
    action: item.action as AuditAction,
    actorEmail: String(item.actorEmail ?? ""),
    target: String(item.target ?? ""),
    ...(item.detail ? { detail: String(item.detail) } : {}),
    createdAt: String(item.createdAt ?? ""),
    ...(typeof item.expiresAt === "number" ? { expiresAt: item.expiresAt } : {}),
  };
}

export const auditRepository: AuditRepository = {
  async append(event) {
    await getDocumentClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.auditEvent(currentTenant(), utcDay(new Date(event.createdAt)), event.createdAt, event.id),
          ...event,
          entityType: ENTITY,
          expiresAt: expiresAtSeconds(event.createdAt, RETENTION.auditDays),
        },
      }),
    );
  },

  async listByDay(day, limit) {
    const items = await queryAll(
      {
        TableName: getTableName(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.auditDayPartition(currentTenant(), day) },
        // Newest first within the day; the sort key leads with `createdAt`.
        ScanIndexForward: false,
      },
      limit,
    );
    return notExpired(items, Date.now()).map(toEvent);
  },
};
