/**
 * Usage repository. Daily per-agent rows hold per-model maps (`calls`,
 * `inputTokens`, `outputTokens`, `cachedTokens`, `costUsd`) incremented
 * under the row lock, so two runs finishing at once both land.
 *
 * A map added after rows already existed materialises on the row's next
 * write, so a day that saw one more call carries it and an older day reads as
 * `{}`. No backfill: the question `cachedTokens` answers is "is the cache
 * working *now*".
 */

import { keys } from "@/infrastructure/db/keys";
import {
  CONDITIONAL_WRITE_FAILED,
  TRANSACTION_CANCELLED,
  getItem,
  queryItems,
  transact,
  updateItem,
  type Item,
  type QueryInput,
  type TransactOp,
} from "@/infrastructure/db/store";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import { daysBetween } from "@/shared/date";
import type { ActorUsageRow, MemberUsageRow, UsageDelta, UsageRow } from "@/domain/usage/types";
import { agentIsLive } from "@/infrastructure/db/agentLifecycle";

/**
 * Attribute the once-per-day notification claim is written to. One per kind, so
 * crossing the alert threshold does not consume the block notification.
 */
const ALERT_MARKER: Record<CostAlertKind, string> = {
  alert: "alertedAt",
  block: "blockedAt",
};

const COUNTERS = ["calls", "inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const;

/** Rows read at once while a usage view drains a bounded date range. */
const USAGE_PAGE_SIZE = 100;

async function listUsageItems(
  input: QueryInput,
  cursorAttribute: "SK" | "GSI1SK" = "SK",
  maxItems?: number,
): Promise<Item[]> {
  const found: Item[] = [];
  let after: string | undefined;
  for (;;) {
    if (maxItems !== undefined && found.length >= maxItems) {
      return found;
    }
    const pageSize =
      maxItems === undefined
        ? USAGE_PAGE_SIZE
        : Math.min(USAGE_PAGE_SIZE, maxItems - found.length);
    const page = await queryItems({ ...input, after, limit: pageSize });
    found.push(...page);
    if (page.length < pageSize) {
      return found;
    }
    // Never a fallback: an empty cursor is `sk > ''`, which matches the whole
    // partition again rather than ending the walk, so a row missing the
    // attribute would spin here instead of failing.
    const cursor = page.at(-1)?.[cursorAttribute];
    if (typeof cursor !== "string" || cursor === "") {
      throw new Error(`usage row has no ${cursorAttribute} to page from`);
    }
    after = cursor;
  }
}

function toUsageRow(item: Item): UsageRow {
  return {
    agentName: String(item.agentName ?? ""),
    date: String(item.date ?? ""),
    calls: (item.calls as Record<string, number>) ?? {},
    inputTokens: (item.inputTokens as Record<string, number>) ?? {},
    outputTokens: (item.outputTokens as Record<string, number>) ?? {},
    // Always present on a row this repository wrote; `{}` is what a row from
    // before the field existed reads as.
    cachedTokens: (item.cachedTokens as Record<string, number>) ?? {},
    costUsd: (item.costUsd as Record<string, number>) ?? {},
  };
}

function toActorUsageRow(item: Item): ActorUsageRow {
  return {
    ...toUsageRow(item),
    actor: String(item.actor ?? ""),
    userId: String(item.userId ?? ""),
  };
}

/**
 * The row after `delta` is added into it. Metadata and `extra` are written
 * only where the row has none — the row's identity is set once — and every
 * counter map gains the delta's model.
 */
function added(row: Item | null, delta: UsageDelta, extra: Item): Item {
  const next: Item = {
    ...row,
    entityType: row?.entityType ?? extra.entityType,
    agentName: row?.agentName ?? delta.agentName,
    date: row?.date ?? delta.date,
    // Retention runs from the usage date, so a day's row is never purged
    // mid-aggregation and backfilled dates don't linger.
    expiresAt: row?.expiresAt ?? expiresAtSeconds(`${delta.date}T00:00:00Z`, RETENTION.usageDays),
  };
  for (const [name, value] of Object.entries(extra)) {
    next[name] = row?.[name] ?? value;
  }
  const amounts: Record<(typeof COUNTERS)[number], number> = {
    calls: delta.calls,
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    cachedTokens: delta.cachedTokens ?? 0,
    costUsd: delta.costUsd,
  };
  for (const counter of COUNTERS) {
    const map = { ...((row?.[counter] as Record<string, number> | undefined) ?? {}) };
    map[delta.model] = (map[delta.model] ?? 0) + amounts[counter];
    next[counter] = map;
  }
  return next;
}

export class PostgresUsageRepository implements UsageRepository {
  async record(delta: UsageDelta): Promise<void> {
    if (!delta.userId || !delta.actor) throw new Error("Usage requires an authenticated Studio caller");
    if (delta.idempotencyKey !== undefined && (!delta.idempotencyKey || delta.idempotencyKey.length > 256)) {
      throw new Error("Invalid usage event identity");
    }
    const receipt = delta.idempotencyKey ? keys.usageReceipt(delta.userId, delta.agentName, delta.idempotencyKey) : undefined;
    const replayed = async () => {
      const item = receipt ? await getItem(receipt) : null;
      if (!item) return false;
      const stored = (item.delta ?? {}) as Record<string, unknown>;
      const entries = Object.entries(delta).filter(([, value]) => value !== undefined);
      if (Object.keys(stored).length !== entries.length || !entries.every(([key, value]) => stored[key] === value)) {
        throw new Error("Usage event identity has a different payload");
      }
      return true;
    };
    if (await replayed()) return;
    const agentKey = keys.agent(delta.agentName);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const live = agentIsLive(await getItem(agentKey));
      const ops: TransactOp[] = [
        { kind: "check", key: agentKey, condition: row => agentIsLive(row) === live },
        ...(receipt ? [{ kind: "put" as const, item: { ...receipt, entityType: "UsageReceipt", delta,
          expiresAt: expiresAtSeconds(delta.date + "T00:00:00Z", RETENTION.usageDays) },
          condition: (item: Item | null) => item === null }] : []),
        { kind: "update", key: keys.usageMember(delta.userId, delta.date, delta.agentName),
          patch: item => added(item, delta, { entityType: "UsageMember", userId: delta.userId }) },
        ...(live ? this.agentProjections(delta) : []),
      ];
      try { await transact(ops); return; }
      catch (error) {
        if (!(error instanceof Error) || error.name !== TRANSACTION_CANCELLED) throw error;
        if (await replayed()) return;
        // A definitive lifecycle transition rolled back the whole transaction.
        // Settle the real bill once without recreating deleted Agent-owned rows.
        if (attempt === 0 && live && !agentIsLive(await getItem(agentKey))) continue;
        throw error;
      }
    }
  }

  private agentProjections(delta: UsageDelta): TransactOp[] {
    return [
      { kind: "update", key: keys.usage(delta.agentName, delta.date), patch: item => added(item, delta, {
        entityType: "Usage", GSI1PK: keys.usageDatePartition(delta.date), GSI1SK: delta.agentName,
      }) },
      { kind: "update", key: keys.usageActor(delta.agentName, delta.date, delta.actor, delta.userId),
        patch: item => added(item, delta, { entityType: "Usage", actor: delta.actor, userId: delta.userId }) },
    ];
  }

  async listMemberDays(userId: string, from: string, to: string): Promise<MemberUsageRow[]> {
    const items = await listUsageItems({
      pk: keys.usageMemberPartition(userId),
      // The agent follows the date in the sort key, so the upper bound has
      // to sort after every agent on `to` — bound by the prefix rather
      // than by any agent name guessed for it.
      sk: { between: [keys.usageMemberPrefix(from), `${keys.usageMemberPrefix(to)}￿`] },
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map((item) => ({
      ...toUsageRow(item),
      userId: String(item.userId ?? userId),
    }));
  }

  async listActorsByAgent(
    agentName: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<ActorUsageRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("actor usage limit must be a positive integer");
    }
    const items = await listUsageItems(
      {
        pk: keys.usage(agentName, from).PK,
        // The upper bound has to sort after every actor on `to`, and actor ids
        // are unbounded strings — so bound by the prefix of the day after,
        // exclusive, rather than by any suffix guessed for `to` itself.
        sk: { between: [keys.usageActorPrefix(from), `${keys.usageActorPrefix(to)}￿`] },
        notExpiredAt: Math.floor(Date.now() / 1000),
      },
      "SK",
      limit,
    );
    return items.map(toActorUsageRow);
  }

  async getDay(agentName: string, date: string): Promise<UsageRow | null> {
    const item = await getItem(keys.usage(agentName, date));
    if (!item) {
      return null;
    }
    // The sweep is periodic, so an expired row can still be read. Counting it
    // would charge an agent for a day that has already been retired.
    return isExpired(item.expiresAt, Date.now()) ? null : toUsageRow(item);
  }

  async claimAlert(agentName: string, date: string, kind: CostAlertKind): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await updateItem(
        keys.usage(agentName, date),
        (row) => ({ ...row, [marker]: new Date().toISOString() }),
        // The row exists by construction — the guard only claims after reading
        // spend off it — but requiring it here keeps a claim from materialising
        // a usage row for an agent that never ran.
        (row) => row !== null && row[marker] === undefined,
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === CONDITIONAL_WRITE_FAILED) {
        return false;
      }
      throw error;
    }
  }

  async claimMonthAlert(
    agentName: string,
    month: string,
    kind: CostAlertKind,
  ): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await transact([
        { kind: "check", key: keys.agent(agentName), condition: agentIsLive },
        { kind: "update", key: keys.usageMonthClaim(agentName, month),
          patch: row => ({ ...row, [marker]: new Date().toISOString(),
            entityType: row?.entityType ?? "UsageMonthClaim",
            expiresAt: row?.expiresAt ?? expiresAtSeconds(`${month}-01T00:00:00Z`, RETENTION.usageDays) }),
          condition: row => row === null || row[marker] === undefined },
      ]);
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === TRANSACTION_CANCELLED) {
        return false;
      }
      throw error;
    }
  }

  async listByAgent(agentName: string, from: string, to: string): Promise<UsageRow[]> {
    const fromKey = keys.usage(agentName, from);
    const toKey = keys.usage(agentName, to);
    const items = await listUsageItems({
      pk: fromKey.PK,
      sk: { between: [fromKey.SK, toKey.SK] },
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map(toUsageRow);
  }

  async listByDateRange(from: string, to: string): Promise<UsageRow[]> {
    const rows: UsageRow[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const date of daysBetween(from, to)) {
      const items = await listUsageItems(
        {
          index: "GSI1",
          pk: keys.usageDatePartition(date),
          notExpiredAt: now,
        },
        "GSI1SK",
      );
      rows.push(...items.map(toUsageRow));
    }
    return rows;
  }
}

/** Shared singleton wired into the composition root. */
export const usageRepository = new PostgresUsageRepository();
