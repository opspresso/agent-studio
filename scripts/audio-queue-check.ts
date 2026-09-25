import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withTransaction } from "@/infrastructure/db/client";
import { keys } from "@/infrastructure/db/keys";
import { migrate } from "@/infrastructure/db/migrations";
import { assertLocalDatabase } from "./local-database";

/** Verify migration 8 against its original stored job shape. */
export async function checkAudioQueueMigration(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL!, true);
  const schema = `audio_queue_${randomUUID().replaceAll("-", "")}`;
  await withTransaction(async (client) => {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await migrate((work) => work(client));
    await client.query("DELETE FROM schema_migrations WHERE version = 8");
    const agentName = "queue-migration";
    const dueAt = "2026-09-13T00:02:00.000Z";
    const jobs = ["z-first", "a-second"].map((id, index) => ({
      ...keys.audioJob(agentName, id), entityType: "AudioJob", userEmail: "owner@example.test",
      ...keys.audioJobDueIndex(dueAt, agentName, id),
      job: { id, projectName: agentName, dueAt, status: index ? "queued" : "running", stage: "transcribing",
        revision: 3, createdAt: "2026-09-13T00:00:00.000Z", attempt: index ? 0 : 1, receipts: { transcript: "existing-transcript" },
        ...(index ? {} : { lease: { token: "worker", until: dueAt } }) },
    }));
    for (const item of [...jobs, { ...keys.audioJobSlots(agentName), jobIds: jobs.map((item) => item.job.id) },
      { ...keys.audioJobSlots("empty"), jobIds: [] }]) {
      await client.query("INSERT INTO items (pk, sk, data) VALUES ($1, $2, $3::jsonb)", [item.PK, item.SK, JSON.stringify(item)]);
    }
    await migrate((work) => work(client));
    await migrate((work) => work(client));
    const due = (await client.query("SELECT data FROM items WHERE gsi1pk = $1", [keys.audioJobDueQuery(dueAt).pk])).rows;
    assert.equal(due.length, 1);
    assert.deepEqual(due[0].data, { ...keys.audioJobSlots(agentName), entityType: "AudioJobQueue", projectName: agentName,
      jobIds: ["z-first", "a-second"], dueAt, ...keys.audioJobDueIndex(dueAt, agentName, "z-first") });
    for (const item of jobs) {
      const stored = (await client.query("SELECT data FROM items WHERE pk = $1 AND sk = $2", [item.PK, item.SK])).rows[0].data;
      assert.deepEqual(stored.job, { ...item.job, ...(item.job.attempt ? { startedAt: item.job.createdAt } : {}) },
        "pending state, deadline, lease and existing output receipts survive");
      assert.equal(stored.GSI1PK, undefined);
    }
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  });
  console.log("[ok] audio queue migration: FIFO index, pending state/lease/receipt preservation and idempotent boot");
}
