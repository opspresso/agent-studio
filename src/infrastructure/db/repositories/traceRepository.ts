import type { ListTracesOptions, TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import { keys } from "@/infrastructure/db/keys";
import { conditions, getItem, queryItems, transact, type SortKeyMatch } from "@/infrastructure/db/store";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";
import { boundedPageLimit } from "@/shared/pageLimit";

const MAX_SPANS = 100;

function fromItem(item: Record<string, unknown>): Trace {
  return {
    traceId: String(item.traceId ?? ""),
    projectName: String(item.projectName ?? ""),
    versionName: String(item.versionName ?? ""),
    projectType: String(item.projectType ?? ""),
    ...(Array.isArray(item.ancestry) ? { ancestry: item.ancestry as string[] } : {}),
    ...(item.actor ? { actor: item.actor as Trace["actor"] } : {}),
    ...(typeof item.conversation === "string" ? { conversation: item.conversation } : {}),
    status: item.status as Trace["status"],
    spans: (item.spans as Trace["spans"] | undefined) ?? [],
    ...(typeof item.spansDropped === "number" ? { spansDropped: item.spansDropped } : {}),
    // The recorder has always written these and this mapping never read them
    // back, so the warning banner the traces page renders was never reachable:
    // every trace came out of storage as if the run had lost nothing.
    ...(Array.isArray(item.warnings) ? { warnings: item.warnings as string[] } : {}),
    startedAt: String(item.startedAt ?? item.createdAt ?? ""),
    endedAt: String(item.endedAt ?? ""),
    durationMs: Number(item.durationMs ?? 0),
    error: item.error as string | undefined,
    createdAt: String(item.createdAt ?? ""),
  };
}

export class PostgresTraceRepository implements TraceRepository {
  async put(trace: Trace): Promise<void> {
    const traceKey = keys.trace(trace.traceId);
    // Body and index row share one expiry so the ref never dangles.
    const expiresAt = expiresAtSeconds(trace.createdAt, RETENTION.traceDays);
    await transact([
      {
        kind: "check",
        key: keys.project(trace.projectName),
        condition: (row) => row !== null && row.deletingAt === undefined,
      },
      {
        kind: "put",
        item: {
          ...trace,
          spans: trace.spans.slice(0, MAX_SPANS),
          ...traceKey,
          entityType: "TRACE",
          GSI1PK: keys.traceProjectPartition(trace.projectName),
          GSI1SK: `${trace.createdAt}#${trace.traceId}`,
          expiresAt,
        },
        condition: conditions.notExists,
      },
      {
        kind: "put",
        item: {
          ...keys.traceRef(trace.projectName, trace.createdAt, trace.traceId),
          entityType: "TRACE_REF",
          tracePK: traceKey.PK,
          traceSK: traceKey.SK,
          expiresAt,
        },
        condition: conditions.notExists,
      },
    ]);
  }

  async get(traceId: string): Promise<Trace | null> {
    const item = await getItem(keys.trace(traceId));
    if (!item || isExpired(item.expiresAt, Date.now())) {
      return null;
    }
    return fromItem(item);
  }

  async listByProject(projectName: string, options: ListTracesOptions = {}): Promise<Trace[]> {
    const { limit = 50, from, to } = options;
    // GSI1SK is `${createdAt}#${traceId}`; filter on the date prefix. The upper
    // bound appends ￿ so the whole "to" day (with any time/id suffix) is included.
    let sk: SortKeyMatch | undefined;
    if (from && to) {
      sk = { between: [from, `${to}￿`] };
    } else if (from) {
      sk = { gte: from };
    } else if (to) {
      sk = { between: ["", `${to}￿`] };
    }
    const items = await queryItems({
      index: "GSI1",
      pk: keys.traceProjectPartition(projectName),
      sk,
      forward: false,
      limit: boundedPageLimit(limit),
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map(fromItem);
  }
}

export const traceRepository = new PostgresTraceRepository();
