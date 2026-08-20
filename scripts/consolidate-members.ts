/**
 * Consolidate duplicated auth `user` rows left behind by table migrations.
 *
 * A migration that copies user rows without their AUTHUNIQUE lock rows leaves
 * the next sign-in free to create a second user for the same email: the create
 * path guards on the lock row alone (see `createItem` in
 * `src/infrastructure/db/authAdapter.ts`). The person then exists twice — the
 * lock points at the new row, the old row is orphaned along with its account
 * and session rows, and the members console lists both.
 *
 * This walks every auth user row, groups them by email, and for each duplicate
 * group keeps the row the email lock names (falling back to the most recently
 * seen row when no lock resolves), merges what the stale rows knew better —
 * the earliest `createdAt` is the person's real join date, the latest
 * `lastLoginAt` their real last visit, a stored tier beats an absent one — and
 * deletes the stale rows together with their account rows, session rows and
 * session-token locks. An email lock that is missing or names a deleted row is
 * rewritten to name the kept one.
 *
 * Idempotent and dry-run by default: a second run finds no duplicate groups
 * and reports nothing to do.
 *
 *   AWS_REGION=... DYNAMODB_TABLE_NAME=... \
 *     pnpm tsx scripts/consolidate-members.ts [--apply]
 */

import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

process.env.STAGE ??= "local";

const apply = process.argv.includes("--apply");

export interface AuthUserRow {
  id: string;
  email: string;
  tier?: string;
  createdAt?: string;
  lastLoginAt?: string;
}

/** An account or session row: what ties it to a user is `userId`. */
export interface AuthLinkedRow {
  id: string;
  userId: string;
  /** Sessions only — names the AUTHUNIQUE token lock that goes with the row. */
  token?: string;
}

export interface ConsolidationPlan {
  merges: Array<{
    email: string;
    canonicalId: string;
    set: Partial<Pick<AuthUserRow, "createdAt" | "lastLoginAt" | "tier">>;
  }>;
  deleteUsers: Array<{ email: string; id: string }>;
  deleteAccounts: string[];
  deleteSessions: AuthLinkedRow[];
  lockRepairs: Array<{ email: string; targetId: string; observedTargetId?: string }>;
}

/** ISO instants compare lexicographically, so string order is time order. */
function lastSeen(row: AuthUserRow): string {
  return row.lastLoginAt ?? row.createdAt ?? "";
}

function minDefined(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => value !== undefined);
  return defined.length > 0 ? defined.sort()[0] : undefined;
}

function maxDefined(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => value !== undefined);
  return defined.length > 0 ? defined.sort().at(-1) : undefined;
}

/**
 * Decide everything before touching anything. Pure so the policy — who is
 * kept, what is merged, what is deleted — is unit-testable without a table.
 */
export function planConsolidation(
  users: AuthUserRow[],
  locks: ReadonlyMap<string, string>,
  accounts: AuthLinkedRow[],
  sessions: AuthLinkedRow[],
): ConsolidationPlan {
  const byEmail = new Map<string, AuthUserRow[]>();
  for (const user of users) {
    const group = byEmail.get(user.email) ?? [];
    group.push(user);
    byEmail.set(user.email, group);
  }

  const plan: ConsolidationPlan = {
    merges: [],
    deleteUsers: [],
    deleteAccounts: [],
    deleteSessions: [],
    lockRepairs: [],
  };
  const staleIds = new Set<string>();

  for (const [email, group] of byEmail) {
    if (group.length < 2) {
      continue;
    }
    const lockTarget = locks.get(email);
    // The lock is what sign-in resolves through, so the row it names is the
    // one the person is actually using; recency is only the tiebreak for a
    // lock that is missing or dangling.
    const canonical =
      group.find((row) => row.id === lockTarget) ??
      [...group].sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)))[0]!;
    const stale = group.filter((row) => row !== canonical);

    const createdAt = minDefined(group.map((row) => row.createdAt));
    const lastLoginAt = maxDefined(group.map((row) => row.lastLoginAt));
    const tier = canonical.tier || stale.map((row) => row.tier).find((value) => value);
    const set: ConsolidationPlan["merges"][number]["set"] = {};
    if (createdAt !== undefined && createdAt !== canonical.createdAt) {
      set.createdAt = createdAt;
    }
    if (lastLoginAt !== undefined && lastLoginAt !== canonical.lastLoginAt) {
      set.lastLoginAt = lastLoginAt;
    }
    if (tier !== undefined && tier !== canonical.tier) {
      set.tier = tier;
    }
    if (Object.keys(set).length > 0) {
      plan.merges.push({ email, canonicalId: canonical.id, set });
    }

    for (const row of stale) {
      staleIds.add(row.id);
      plan.deleteUsers.push({ email, id: row.id });
    }
    if (lockTarget !== canonical.id) {
      plan.lockRepairs.push({
        email,
        targetId: canonical.id,
        ...(lockTarget !== undefined ? { observedTargetId: lockTarget } : {}),
      });
    }
  }

  plan.deleteAccounts = accounts.filter((row) => staleIds.has(row.userId)).map((row) => row.id);
  plan.deleteSessions = sessions.filter((row) => staleIds.has(row.userId));
  return plan;
}

function isEmpty(plan: ConsolidationPlan): boolean {
  return (
    plan.merges.length === 0 &&
    plan.deleteUsers.length === 0 &&
    plan.deleteAccounts.length === 0 &&
    plan.deleteSessions.length === 0 &&
    plan.lockRepairs.length === 0
  );
}

async function main() {
  // Imported here rather than at module scope: importing this file for its
  // pure planner must not pull the DB client's env requirements with it.
  const db = await import("@/infrastructure/db/client");
  const { keys } = await import("@/infrastructure/db/keys");
  const { queryAll } = await import("@/infrastructure/db/query");
  const client = db.getDocumentClient();
  const table = db.getTableName();

  const authRows = (model: string) =>
    queryAll({
      TableName: table,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": keys.authModelPartition(model) },
    });

  const users: AuthUserRow[] = [];
  for (const item of await authRows("user")) {
    if (typeof item.id === "string" && typeof item.email === "string") {
      users.push({
        id: item.id,
        email: item.email,
        ...(typeof item.tier === "string" && item.tier !== "" ? { tier: item.tier } : {}),
        ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
        ...(typeof item.lastLoginAt === "string" ? { lastLoginAt: item.lastLoginAt } : {}),
      });
    } else {
      console.warn(`Skipping malformed user row: ${String(item.PK)}`);
    }
  }

  const toLinked = (item: Record<string, unknown>): AuthLinkedRow | undefined =>
    typeof item.id === "string" && typeof item.userId === "string"
      ? {
          id: item.id,
          userId: item.userId,
          ...(typeof item.token === "string" ? { token: item.token } : {}),
        }
      : undefined;
  const accounts = (await authRows("account")).flatMap((item) => toLinked(item) ?? []);
  const sessions = (await authRows("session")).flatMap((item) => toLinked(item) ?? []);

  const locks = new Map<string, string>();
  for (const email of new Set(users.map((user) => user.email))) {
    const result = await client.send(
      new GetCommand({
        TableName: table,
        Key: keys.authUnique("user", "email", email),
        ConsistentRead: true,
      }),
    );
    const targetId = result.Item?.targetId;
    if (typeof targetId === "string") {
      locks.set(email, targetId);
    }
  }

  const plan = planConsolidation(users, locks, accounts, sessions);
  if (isEmpty(plan)) {
    console.log(`No duplicate members found (${users.length} user rows).`);
    return;
  }

  const staleByEmail = new Map<string, string[]>();
  for (const user of plan.deleteUsers) {
    staleByEmail.set(user.email, [...(staleByEmail.get(user.email) ?? []), user.id]);
  }
  for (const merge of plan.merges) {
    console.log(`${merge.email}: keep ${merge.canonicalId}, set ${JSON.stringify(merge.set)}`);
  }
  for (const [email, ids] of staleByEmail) {
    console.log(`${email}: delete user ${ids.join(", ")}`);
  }
  for (const repair of plan.lockRepairs) {
    console.log(
      `${repair.email}: repoint lock ${repair.observedTargetId ?? "(missing)"} → ${repair.targetId}`,
    );
  }
  console.log(
    `${apply ? "Applying" : "Would apply"}: ${plan.merges.length} merges, ` +
      `${plan.deleteUsers.length} user, ${plan.deleteAccounts.length} account, ` +
      `${plan.deleteSessions.length} session deletions, ${plan.lockRepairs.length} lock repairs.`,
  );
  if (!apply) {
    console.log("Dry run — pass --apply to write.");
    return;
  }

  for (const merge of plan.merges) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = Object.entries(merge.set).map(([field, value], index) => {
      names[`#f${index}`] = field;
      values[`:v${index}`] = value;
      return `#f${index} = :v${index}`;
    });
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: keys.auth("user", merge.canonicalId),
        ConditionExpression: "attribute_exists(PK)",
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }
  // Plain deletes on purpose: the email lock belongs to the canonical row, so
  // the adapter's delete path (which removes the lock alongside the row) must
  // not be reused here.
  for (const user of plan.deleteUsers) {
    await client.send(new DeleteCommand({ TableName: table, Key: keys.auth("user", user.id) }));
  }
  for (const id of plan.deleteAccounts) {
    await client.send(new DeleteCommand({ TableName: table, Key: keys.auth("account", id) }));
  }
  for (const session of plan.deleteSessions) {
    await client.send(new DeleteCommand({ TableName: table, Key: keys.auth("session", session.id) }));
    if (session.token) {
      await client.send(
        new DeleteCommand({
          TableName: table,
          Key: keys.authUnique("session", "token", session.token),
          ConditionExpression: "attribute_not_exists(PK) OR targetId = :targetId",
          ExpressionAttributeValues: { ":targetId": session.id },
        }),
      );
    }
  }
  for (const repair of plan.lockRepairs) {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...keys.authUnique("user", "email", repair.email),
          entityType: "auth:unique",
          model: "user",
          field: "email",
          value: repair.email,
          targetId: repair.targetId,
        },
        // Only replace the lock state the plan was computed from — a racing
        // write wins, and a re-run picks the survivor up.
        ConditionExpression:
          repair.observedTargetId !== undefined
            ? "attribute_not_exists(PK) OR targetId = :observed"
            : "attribute_not_exists(PK)",
        ...(repair.observedTargetId !== undefined
          ? { ExpressionAttributeValues: { ":observed": repair.observedTargetId } }
          : {}),
      }),
    );
  }
  console.log("Done. Re-run without --apply to confirm nothing is left.");
}

// Guarded so the test file can import `planConsolidation` without running the
// migration: under vitest, argv[1] is the runner, not this script.
if (process.argv[1]?.includes("consolidate-members")) {
  main().catch((error) => {
    console.error("CONSOLIDATION FAILED:", error);
    process.exit(1);
  });
}
