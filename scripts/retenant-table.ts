/**
 * Move a default-tenant deployment's rows onto a named tenant.
 *
 * The tenant key scheme was chosen so that adopting it costs nothing: the
 * default tenant's prefix is empty, so every row an existing deployment already
 * wrote keeps exactly the key it has. What this script is for is the *next*
 * step — a single-tenant install deciding to become one tenant among several,
 * at which point its rows have to move behind `T#{id}#`.
 *
 * Re-keying rather than dual-reading, deliberately. A fallback read would double
 * every lookup forever and leave two answers to "where does this row live",
 * which is precisely the ambiguity a key scheme exists to remove. A copy-then-
 * delete pass is bounded, runs once, and can be verified by reading the table
 * afterwards.
 *
 * Properties worth knowing before running it:
 *
 * - **It is not atomic.** DynamoDB has no cross-partition transaction of this
 *   size. It copies first and deletes after, per item, so an interrupted run
 *   leaves duplicates rather than losses — and re-running it is safe, because
 *   a row already moved is no longer at the source key.
 * - **Run it with the app stopped.** A row written between the copy and the
 *   delete is written to the old key and then deleted.
 * - **`--dry-run` is the default.** Nothing is written without `--apply`.
 *
 *   pnpm tsx --env-file=.env.local scripts/retenant-table.ts --tenant=acme
 *   pnpm tsx --env-file=.env.local scripts/retenant-table.ts --tenant=acme --apply
 */

import { DeleteCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient, getTableName } from "@/infrastructure/db/client";
import { isSlug } from "@/shared/slug";
import { DEFAULT_TENANT } from "@/shared/tenantContext";

/**
 * Key prefixes that belong to a tenant. Anything else — Better Auth rows, the
 * app settings row, the organization registry — is deliberately global and is
 * left where it is (see `UNSCOPED_KEYS` in `tests/architecture.test.ts`).
 *
 * This list is a second spelling of what `scope(tenant)` prefixes in
 * `keys.ts`, and a prefix that exists there and not here is a row this
 * migration silently leaves behind while reporting `moved N of M`. Since the
 * doc note above is true — a re-run skips what already moved — the omission is
 * permanent. `tests/architecture.test.ts` cross-checks the two, which is how
 * `SETTINGS#workspace` was found missing.
 *
 * `SETTINGS#workspace` and not `SETTINGS#`: the app row is `SETTINGS#app` and
 * belongs to no tenant, so the shorter prefix would take it too.
 */
const SCOPED_PREFIXES = [
  "PROJECT#",
  "CHAT#",
  "CHATOWNER#",
  "AUDIT#",
  "SKILL#",
  "MCP#",
  "AGENT#",
  "TRIGGERIDEM#",
  "MCPOAUTH#",
  "USAGE#",
  "USAGEDATE#",
  "RUNSLOT#",
  "SLACKEVENT#",
  "A2ATASK#",
  "TRACE#",
  "TRACEPROJECT#",
  "TYPE#",
  "SETTINGS#workspace",
];

function belongsToTenant(pk: string): boolean {
  return SCOPED_PREFIXES.some((prefix) => pk.startsWith(prefix));
}

/** Every GSI partition attribute is a key too, and misses here leak across tenants. */
const INDEX_PARTITION_ATTRIBUTES = ["GSI1PK"] as const;

function argValue(name: string): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

/**
 * Move every tenant-scoped row onto `tenant`. Exported so the integration check
 * exercises the migration itself rather than a second copy of it.
 *
 * @returns how many rows were moved (or would be, without `apply`).
 */
export async function retenantTable(opts: {
  tenant: string;
  apply: boolean;
}): Promise<{ scanned: number; moved: number }> {
  const { tenant, apply } = opts;
  const prefix = `T#${tenant}#`;
  const client = getDocumentClient();
  const table = getTableName();
  let scanned = 0;
  let moved = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await client.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: lastKey }),
    );
    for (const item of page.Items ?? []) {
      scanned += 1;
      const pk = String(item.PK ?? "");
      if (!belongsToTenant(pk) || pk.startsWith("T#")) {
        continue;
      }
      const moved_item: Record<string, unknown> = { ...item, PK: `${prefix}${pk}` };
      for (const attribute of INDEX_PARTITION_ATTRIBUTES) {
        const value = item[attribute];
        if (typeof value === "string" && !value.startsWith("T#")) {
          moved_item[attribute] = `${prefix}${value}`;
        }
      }
      moved += 1;
      if (!apply) {
        continue;
      }
      // Copy first: an interruption leaves a duplicate, which a re-run resolves,
      // where deleting first would lose the row outright.
      await client.send(new PutCommand({ TableName: table, Item: moved_item }));
      await client.send(
        new DeleteCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }),
      );
    }
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return { scanned, moved };
}

async function main(): Promise<void> {
  const tenant = argValue("tenant");
  const apply = process.argv.includes("--apply");

  if (!tenant || !isSlug(tenant)) {
    console.error("Usage: retenant-table.ts --tenant=<slug> [--apply]");
    process.exit(1);
  }
  if (tenant === DEFAULT_TENANT) {
    console.error(`"${DEFAULT_TENANT}" is the unprefixed tenant; there is nothing to move it to.`);
    process.exit(1);
  }

  const { scanned, moved } = await retenantTable({ tenant, apply });
  console.log(
    `${apply ? "Moved" : "Would move"} ${moved} of ${scanned} rows in ${getTableName()} ` +
      `to tenant "${tenant}".`,
  );
  if (!apply) {
    console.log("Nothing was written. Re-run with --apply once the app is stopped.");
  }
}

// Only when run as a script; the integration check imports the function above.
if (process.argv[1]?.endsWith("retenant-table.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
