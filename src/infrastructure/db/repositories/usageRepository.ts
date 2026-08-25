/**
 * Usage repository. Daily per-project rows hold per-model maps (`calls`,
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
  getItem,
  queryItems,
  transact,
  updateItem,
  type Item,
  type QueryInput,
} from "@/infrastructure/db/store";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";
import type { CostAlertKind, UsageRepository } from "@/domain/usage/repository";
import { memberEmailFromActorKey } from "@/domain/execution/actor";
import { daysBetween } from "@/shared/date";
import type { ActorUsageRow, MemberUsageRow, UsageDelta, UsageRow } from "@/domain/usage/types";
import { projectIsLive } from "@/infrastructure/db/projectLifecycle";

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
): Promise<Item[]> {
  const found: Item[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await queryItems({ ...input, after, limit: USAGE_PAGE_SIZE });
    found.push(...page);
    if (page.length < USAGE_PAGE_SIZE) {
      return found;
    }
    after = String(page.at(-1)?.[cursorAttribute] ?? "");
  }
}

function toUsageRow(item: Item): UsageRow {
  return {
    projectName: String(item.projectName ?? ""),
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
    projectName: row?.projectName ?? delta.projectName,
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
    await this.addTo(keys.usage(delta.projectName, delta.date), delta, {
      entityType: "Usage",
      GSI1PK: keys.usageDatePartition(delta.date),
      GSI1SK: delta.projectName,
    });
    if (delta.actor) {
      // After the project total, and separately: attribution is additive, so a
      // failure to write who spent it must not lose the fact that it was spent.
      // No GSI entry — this row is only ever read within its project.
      await this.addTo(keys.usageActor(delta.projectName, delta.date, delta.actor), delta, {
        entityType: "Usage",
        actor: delta.actor,
      });
      // Third and last, same additive reasoning: the member's own daily row,
      // which the tier cap and the profile page both read. Only a `user` actor
      // writes one — a machine caller has no personal budget, and a project
      // token deliberately spends against its project's limits, not its
      // owner's.
      const email = memberEmailFromActorKey(delta.actor);
      if (email) {
        await updateItem(keys.usageMember(email, delta.date, delta.projectName), (row) =>
          added(row, delta, { entityType: "UsageMember", email }),
        );
      }
    }
  }

  /**
   * One row's increment, refused while the project is being cascade deleted
   * so a usage row cannot land in a partition the delete is sweeping. The
   * member row above is a *person's* spend in their own partition, which no
   * project deletion touches, so it carries no such check.
   */
  private async addTo(key: { PK: string; SK: string }, delta: UsageDelta, extra: Item): Promise<void> {
    await transact([
      { kind: "check", key: keys.project(delta.projectName), condition: projectIsLive },
      { kind: "update", key, patch: (row) => added(row, delta, extra) },
    ]);
  }

  async listMemberDays(email: string, from: string, to: string): Promise<MemberUsageRow[]> {
    const items = await listUsageItems({
      pk: keys.usageMemberPartition(email),
      // The project follows the date in the sort key, so the upper bound has
      // to sort after every project on `to` — bound by the prefix rather
      // than by any project name guessed for it.
      sk: { between: [keys.usageMemberPrefix(from), `${keys.usageMemberPrefix(to)}￿`] },
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map((item) => ({
      email: String(item.email ?? email),
      projectName: String(item.projectName ?? ""),
      date: String(item.date ?? ""),
      calls: (item.calls as Record<string, number>) ?? {},
      inputTokens: (item.inputTokens as Record<string, number>) ?? {},
      outputTokens: (item.outputTokens as Record<string, number>) ?? {},
      cachedTokens: (item.cachedTokens as Record<string, number>) ?? {},
      costUsd: (item.costUsd as Record<string, number>) ?? {},
    }));
  }

  async listActorsByProject(
    projectName: string,
    from: string,
    to: string,
  ): Promise<ActorUsageRow[]> {
    const items = await listUsageItems({
      pk: keys.usage(projectName, from).PK,
      // The upper bound has to sort after every actor on `to`, and actor ids
      // are unbounded strings — so bound by the prefix of the day after,
      // exclusive, rather than by any suffix guessed for `to` itself.
      sk: { between: [keys.usageActorPrefix(from), `${keys.usageActorPrefix(to)}￿`] },
      notExpiredAt: Math.floor(Date.now() / 1000),
    });
    return items.map(toActorUsageRow);
  }

  async getDay(projectName: string, date: string): Promise<UsageRow | null> {
    const item = await getItem(keys.usage(projectName, date));
    if (!item) {
      return null;
    }
    // The sweep is periodic, so an expired row can still be read. Counting it
    // would charge a project for a day that has already been retired.
    return isExpired(item.expiresAt, Date.now()) ? null : toUsageRow(item);
  }

  async claimAlert(projectName: string, date: string, kind: CostAlertKind): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await updateItem(
        keys.usage(projectName, date),
        (row) => ({ ...row, [marker]: new Date().toISOString() }),
        // The row exists by construction — the guard only claims after reading
        // spend off it — but requiring it here keeps a claim from materialising
        // a usage row for a project that never ran.
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
    projectName: string,
    month: string,
    kind: CostAlertKind,
  ): Promise<boolean> {
    const marker = ALERT_MARKER[kind];
    try {
      await updateItem(
        keys.usageMonthClaim(projectName, month),
        // Unlike the daily claim, this row does not exist by construction —
        // the first claim of a month materialises it, retained as long as the
        // usage rows whose window it closes.
        (row) => ({
          ...row,
          [marker]: new Date().toISOString(),
          entityType: row?.entityType ?? "UsageMonthClaim",
          expiresAt:
            row?.expiresAt ?? expiresAtSeconds(`${month}-01T00:00:00Z`, RETENTION.usageDays),
        }),
        (row) => row === null || row[marker] === undefined,
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === CONDITIONAL_WRITE_FAILED) {
        return false;
      }
      throw error;
    }
  }

  async listByProject(projectName: string, from: string, to: string): Promise<UsageRow[]> {
    const fromKey = keys.usage(projectName, from);
    const toKey = keys.usage(projectName, to);
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
