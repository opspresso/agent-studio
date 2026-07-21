/**
 * Minimal trace repository. Persists a single trace row per run with a capped
 * spans array, keyed for both direct lookup and per-project listing (GSI1).
 */

import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";

const MAX_SPANS = 100;

export interface TraceRow {
  traceId: string;
  projectName: string;
  spans: unknown[];
  createdAt: string;
}

export interface TraceRepository {
  put(trace: TraceRow): Promise<void>;
  listByProject(projectName: string, limit?: number): Promise<TraceRow[]>;
}

export class DynamoTraceRepository implements TraceRepository {
  async put(trace: TraceRow): Promise<void> {
    const doc = getDocumentClient();
    const spans = trace.spans.slice(0, MAX_SPANS);
    await doc.send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          ...keys.trace(trace.traceId),
          entityType: "Trace",
          traceId: trace.traceId,
          projectName: trace.projectName,
          spans,
          createdAt: trace.createdAt,
          GSI1PK: keys.traceProjectPartition(trace.projectName),
          GSI1SK: trace.createdAt,
        },
      }),
    );
  }

  async listByProject(projectName: string, limit = 50): Promise<TraceRow[]> {
    const doc = getDocumentClient();
    const result = await doc.send(
      new QueryCommand({
        TableName: getTableName(),
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": keys.traceProjectPartition(projectName) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((item) => ({
      traceId: String(item.traceId ?? ""),
      projectName: String(item.projectName ?? ""),
      spans: (item.spans as unknown[]) ?? [],
      createdAt: String(item.createdAt ?? ""),
    }));
  }
}

/** Shared singleton for route/handler wiring. */
export const traceRepository = new DynamoTraceRepository();
