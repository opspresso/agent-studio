import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { getPool } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { conditions, deleteItem, getItem, putItem, transact, type Key } from "@/infrastructure/db/store";
import { withCheckLifecycle } from "./check-lifecycle";
import { assertLocalDatabase } from "./local-database";

async function hasAddressLock(key: Key, granted: boolean): Promise<boolean> {
  const result = await getPool().query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' " +
      "AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) " +
      "AND classid = (hashtext($1)::bigint & 4294967295)::oid " +
      "AND objid = (hashtext($2)::bigint & 4294967295)::oid AND objsubid = 2 " +
      "AND granted = $3) AS present",
    [key.PK, key.SK, granted],
  );
  return result.rows[0]!.present;
}

async function waitUntil(observe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await observe()) {
    assert.ok(Date.now() < deadline, "item-store lock observation timed out");
    await delay(10);
  }
}

/** Observe actual PostgreSQL locks so the race does not depend on query timing. */
export async function checkItemStoreConcurrency(suffix: string): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  for (const kind of ["put", "update"] as const) {
    const target = keys.trace(`store-race-a-${kind}-${suffix}`);
    const gate = keys.trace(`store-race-z-${kind}-${suffix}`);
    await withCheckLifecycle(async cleanup => {
      cleanup(() => deleteItem(target));
      const holder = await getPool().connect();
      let transaction: Promise<unknown> | undefined;
      let overwrite: Promise<unknown> | undefined;
      cleanup(async () => { await Promise.all([transaction, overwrite]); });
      cleanup(() => holder.release(true));
      cleanup(() => holder.query("ROLLBACK"));
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [gate.PK, gate.SK]);

      // The transaction reads the absent target, then waits at a later address.
      transaction = transact([
        kind === "put"
          ? { kind, item: { ...target, value: "transaction" }, condition: conditions.notExists }
          : { kind, key: target, patch: row => ({ ...row, value: "transaction" }) },
        { kind: "check", key: gate, condition: conditions.notExists },
      ]).then(() => undefined, (error: unknown) => error);
      await waitUntil(() => hasAddressLock(target, true));

      let overwriteSettled = false;
      overwrite = putItem({ ...target, value: "unconditional" }).then(
        () => { overwriteSettled = true; },
        (error: unknown) => { overwriteSettled = true; return error; },
      );
      await waitUntil(async () => overwriteSettled || await hasAddressLock(target, false));
      const overtook = overwriteSettled;
      await holder.query("ROLLBACK");
      assert.equal(await transaction, undefined);
      assert.equal(await overwrite, undefined);
      assert.equal(overtook, false, `unconditional put must wait for the absent-row ${kind}`);
      assert.equal((await getItem(target))?.value, "unconditional", "the later write must survive");
    });
  }
}
