import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";

const MAX_SPANS = 100;

function fromItem(item: Record<string, unknown>): Trace {
  return {
    traceId: String(item.traceId ?? ""),
    projectName: String(item.projectName ?? ""),
    versionName: String(item.versionName ?? ""),
    projectType: String(item.projectType ?? ""),
    status: item.status as Trace["status"],
    spans: (item.spans as Trace["spans"] | undefined) ?? [],
    startedAt: String(item.startedAt ?? item.createdAt ?? ""),
    endedAt: String(item.endedAt ?? ""),
    durationMs: Number(item.durationMs ?? 0),
    error: item.error as string | undefined,
    createdAt: String(item.createdAt ?? ""),
  };
}

export class DynamoTraceRepository implements TraceRepository {
  async put(trace: Trace): Promise<void> {
    const traceKey = keys.trace(trace.traceId);
    await getDocumentClient().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getTableName(),
              Key: keys.project(trace.projectName),
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(deletingAt)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: {
                ...trace,
                spans: trace.spans.slice(0, MAX_SPANS),
                ...traceKey,
                entityType: "TRACE",
                GSI1PK: keys.traceProjectPartition(trace.projectName),
                GSI1SK: `${trace.createdAt}#${trace.traceId}`,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: getTableName(),
              Item: {
                ...keys.traceRef(trace.projectName, trace.createdAt, trace.traceId),
                entityType: "TRACE_REF",
                tracePK: traceKey.PK,
                traceSK: traceKey.SK,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  }

  async get(traceId: string): Promise<Trace | null> {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: keys.trace(traceId),
        ConsistentRead: true,
      }),
    );
    return result.Item ? fromItem(result.Item) : null;
  }

  async listByProject(projectName: string, limit = 50): Promise<Trace[]> {
    const result = await getDocumentClient().send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.traceProjectPartition(projectName) },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 100),
      }),
    );
    return (result.Items ?? []).map(fromItem);
  }
}

export const traceRepository = new DynamoTraceRepository();
