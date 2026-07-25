import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { ListTracesOptions, TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { expiresAtSeconds, isExpired, notExpired, RETENTION } from "@/infrastructure/db/ttl";

const MAX_SPANS = 100;
/** Bound on extra pages fetched to refill a list thinned by expired rows. */
const MAX_LIST_PAGES = 5;

function fromItem(item: Record<string, unknown>): Trace {
  return {
    traceId: String(item.traceId ?? ""),
    projectName: String(item.projectName ?? ""),
    versionName: String(item.versionName ?? ""),
    projectType: String(item.projectType ?? ""),
    ...(Array.isArray(item.ancestry) ? { ancestry: item.ancestry as string[] } : {}),
    status: item.status as Trace["status"],
    spans: (item.spans as Trace["spans"] | undefined) ?? [],
    ...(typeof item.spansDropped === "number" ? { spansDropped: item.spansDropped } : {}),
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
    // Body and index row share one expiry so the ref never dangles.
    const expiresAt = expiresAtSeconds(trace.createdAt, RETENTION.traceDays);
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
                expiresAt,
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
                expiresAt,
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
    if (!result.Item || isExpired(result.Item.expiresAt, Date.now())) {
      return null;
    }
    return fromItem(result.Item);
  }

  async listByProject(projectName: string, options: ListTracesOptions = {}): Promise<Trace[]> {
    const { limit = 50, from, to } = options;
    // GSI1SK is `${createdAt}#${traceId}`; filter on the date prefix. The upper
    // bound appends ￿ so the whole "to" day (with any time/id suffix) is included.
    const values: Record<string, unknown> = { ":pk": keys.traceProjectPartition(projectName) };
    let keyCondition = "GSI1PK = :pk";
    if (from && to) {
      keyCondition += " AND GSI1SK BETWEEN :from AND :to";
      values[":from"] = from;
      values[":to"] = `${to}￿`;
    } else if (from) {
      keyCondition += " AND GSI1SK >= :from";
      values[":from"] = from;
    } else if (to) {
      keyCondition += " AND GSI1SK <= :to";
      values[":to"] = `${to}￿`;
    }
    const pageLimit = Math.min(Math.max(limit, 1), 100);
    const client = getDocumentClient();
    const traces: Trace[] = [];
    let lastKey: Record<string, unknown> | undefined;
    // The TTL purge is only eventually consistent, so already-expired rows are
    // filtered in code — after DynamoDB applied `Limit`. Keep pulling pages
    // until the caller's limit is genuinely filled (bounded, so a partition of
    // expired rows can't turn one list into an unbounded scan).
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await client.send(
        new QueryCommand({
          TableName: getTableName(),
          IndexName: "GSI1",
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          Limit: pageLimit,
          ExclusiveStartKey: lastKey,
        }),
      );
      traces.push(...notExpired(result.Items ?? [], Date.now()).map(fromItem));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (traces.length >= pageLimit || !lastKey) {
        break;
      }
    }
    return traces.slice(0, pageLimit);
  }
}

export const traceRepository = new DynamoTraceRepository();
