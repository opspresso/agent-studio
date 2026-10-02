import assert from "node:assert/strict";
import { withCheckLifecycle } from "./check-lifecycle";
import { keys } from "@/infrastructure/db/keys";
import { getPool } from "@/infrastructure/db/client";
import { pluginSyncLock } from "@/infrastructure/db/repositories/pluginSyncRepository";
import { deleteExpired, deleteIndexPartition, deleteItem, deletePartition, getItem, putItem, transact, updateItem } from "@/infrastructure/db/store";

/** Actual PostgreSQL lease refusal and commit ordering; called only by the guarded _test runner. */
export async function checkPluginSyncLock(suffix: string): Promise<void> {
  const repo = `integration/plugin-fence-${suffix}`;
  const lockKey = keys.pluginSyncLock(repo);
  const target = keys.pluginSyncReport(repo);
  await withCheckLifecycle(async cleanup => {
    cleanup(() => deleteItem(lockKey));
    cleanup(() => deleteItem(target));
    const token = await pluginSyncLock.acquire(repo, 60_000);
    assert.ok(token);
    assert.equal(await pluginSyncLock.renew(repo, token, 60_000), true);
    assert.equal(await pluginSyncLock.renew(repo, "not-the-owner", 60_000), false);
    await pluginSyncLock.withOwnership(repo, token, () => putItem({ ...target, value: "preserved", GSI1PK: target.PK, expiresAt: 0 }));
    await updateItem(lockKey, row => ({ ...row, leaseUntil: Date.now() - 1 }));
    assert.equal(await pluginSyncLock.renew(repo, token, 60_000), false, "expired renewal cannot resurrect ownership");
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["put", () => putItem({ ...target, value: "stale" })],
      ["update", () => updateItem(target, row => ({ ...row, value: "stale" }))],
      ["delete", () => deleteItem(target)],
      ["transact", () => transact([{ kind: "put", item: { ...target, value: "stale" } }])],
      ["partition", () => deletePartition(target.PK, { keep: [lockKey.SK] })],
      ["index", () => deleteIndexPartition("GSI1", target.PK)],
      ["expiry", () => deleteExpired(Math.floor(Date.now() / 1000))],
    ];
    for (const [kind, write] of writes) {
      await assert.rejects(pluginSyncLock.withOwnership(repo, token, write),
        { name: kind === "transact" ? "TransactionCancelled" : "ConditionalWriteFailed" }, `${kind} must reject stale ownership`);
      assert.equal((await getItem(target))?.value, "preserved");
    }
    const replacement = await pluginSyncLock.acquire(repo, 60_000);
    assert.ok(replacement && replacement !== token);
    await pluginSyncLock.release(repo, token);
    assert.equal((await getItem(lockKey))?.token, replacement, "stale release must preserve the replacement lease");
    await pluginSyncLock.withOwnership(repo, replacement, () => putItem({ ...target, value: "fresh" }));
    await assert.rejects(pluginSyncLock.withOwnership(repo, token, () => putItem({ ...target, value: "stale" })),
      { name: "ConditionalWriteFailed" });
    assert.equal((await getItem(target))?.value, "fresh");
    await pluginSyncLock.release(repo, replacement);

    // Hold the target row so the old writer acquires its shared lease lock,
    // then waits long enough to expire before evaluating the fence condition.
    const holder = await getPool().connect();
    let holding = false;
    let writing: Promise<unknown> | undefined;
    let stealing: Promise<string | null> | undefined;
    await withCheckLifecycle(async release => {
      release(async () => { await writing; await stealing; });
      release(() => holder.release(true));
      release(async () => { if (holding) await holder.query("ROLLBACK"); });
      await holder.query("BEGIN");
      holding = true;
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))", [target.PK, target.SK]);
      await holder.query("SELECT data FROM items WHERE pk = $1 AND sk = $2 FOR UPDATE", [target.PK, target.SK]);
      const waitingOwner = await pluginSyncLock.acquire(repo, 1_000);
      assert.ok(waitingOwner);
      writing = pluginSyncLock.withOwnership(repo, waitingOwner, () => putItem({ ...target, value: "expired-during-lock-wait" }))
        .then(() => undefined, error => error);
      assert.equal(await remainsPending(writing, 1_500), true, "the writer waits for the target while holding the shared lease lock");
      stealing = pluginSyncLock.acquire(repo, 60_000);
      assert.equal(await remainsPending(stealing, 200), true, "a new owner cannot change the fenced lease before the old transaction ends");
      await holder.query("ROLLBACK");
      holding = false;
      const refused = await writing;
      assert.ok(refused instanceof Error && refused.name === "ConditionalWriteFailed", "expiry is checked after every row-lock wait");
      const winner = await stealing;
      assert.ok(winner && winner !== waitingOwner);
      assert.equal((await getItem(target))?.value, "fresh", "the expired writer never reaches its mutation");
      await pluginSyncLock.withOwnership(repo, winner, () => putItem({ ...target, value: "replacement-after-lock-wait" }));
      assert.equal((await getItem(target))?.value, "replacement-after-lock-wait");
      await pluginSyncLock.release(repo, winner);
    });
  });
}

async function remainsPending(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => false, () => false),
      new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
