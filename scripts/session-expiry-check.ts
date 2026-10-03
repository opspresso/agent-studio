import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getPool } from "@/infrastructure/db/client";
import { deleteExpiredSessions } from "@/infrastructure/db/repositories/memberRepository";
import { runtimeSessionRepository } from "@/infrastructure/db/repositories/runtimeSessionRepository";
import { withCheckLifecycle } from "./check-lifecycle";
import { assertLocalDatabase } from "./local-database";

/** An expired snapshot must not let a sweep delete a concurrently renewed Session. */
export async function checkSessionExpiry(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const pool = getPool();
  const owner = `expiry-${randomUUID()}@example.test`;
  await withCheckLifecycle(async cleanup => {
    const userId = randomUUID();
    cleanup(() => pool.query('DELETE FROM "user" WHERE id = $1', [userId]));
    await pool.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [userId, "Expiry check", owner]);
    for (const kind of ["auth", "runtime"] as const) {
      const table = kind === "auth" ? '"session"' : "runtime_sessions";
      const idColumn = kind === "auth" ? "id" : "session_id";
      const expiryColumn = kind === "auth" ? '"expiresAt"' : "expires_at";
      const id = randomUUID();
      cleanup(() => pool.query(`DELETE FROM ${table} WHERE ${idColumn} = $1`, [id]));
      const now = (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
      const expired = new Date(now.getTime() - 1_000);
      if (kind === "auth") {
        await pool.query('INSERT INTO "session" (id, token, "userId", "expiresAt") VALUES ($1, $2, $3, $4)', [id, randomUUID(), userId, expired]);
      } else {
        await runtimeSessionRepository.save({ sessionId: id, ownerEmail: owner, agentName: "expiry-check", payload: "fixture", expiresAt: expired.toISOString() }, null);
      }
      await withCheckLifecycle(async release => {
        const writer = await pool.connect();
        let sweep: Promise<number | Error> | undefined;
        release(async () => { await sweep; });
        release(() => writer.release(true));
        release(() => writer.query("ROLLBACK"));
        await writer.query("BEGIN");
        const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await writer.query(`UPDATE ${table} SET ${expiryColumn} = $2 WHERE ${idColumn} = $1`, [id, new Date(now.getTime() + 60_000)]);
        // The uncommitted renewal holds the row while the sweep sees the old expiry.
        sweep = (kind === "auth" ? deleteExpiredSessions(now) : runtimeSessionRepository.sweepExpired(now)).catch((error: Error) => error);
        const deadline = Date.now() + 5_000;
        for (;;) {
          const blocked = await pool.query<{ blocked: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [pid],
          );
          if (blocked.rows[0]!.blocked) break;
          assert.ok(Date.now() < deadline, `${kind} sweep did not reach the renewal lock`);
          await delay(10);
        }
        await writer.query("COMMIT");
        assert.equal(typeof await sweep, "number", `${kind} sweep must finish without error`);
        const rows = await pool.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1`, [id]);
        assert.equal(rows.rowCount, 1, `${kind} sweep must preserve a concurrently renewed Session`);
      });
      await pool.query(`UPDATE ${table} SET ${expiryColumn} = $2 WHERE ${idColumn} = $1`, [id, expired]);
      await (kind === "auth" ? deleteExpiredSessions(now) : runtimeSessionRepository.sweepExpired(now));
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1`, [id])).rowCount, 0, `${kind} sweep still deletes expired Sessions`);
    }
  });
  console.log("[ok] auth and SDK Session sweeps preserve concurrent renewals");
}
