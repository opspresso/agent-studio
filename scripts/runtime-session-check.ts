import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runtimeSessionRepository as repository } from "@/infrastructure/db/repositories/runtimeSessionRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { openRuntimeSession, readRuntimeSession } from "@/application/runtime/session";
import type { AgentConfiguration } from "@/domain/agent/types";

/** Called only by integration-check after its dedicated-test-database guard. */
export async function checkRuntimeSessions(): Promise<void> {
  const id = randomUUID();
  const owner = "runtime-integration@example.test";
  const configuration: AgentConfiguration = { agentName: "runtime-integration",  model: "openai/gpt-5-mini", systemPrompt: "",  parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] };
  const services = { repository, cipher: secretCipher, retentionDays: 1 };
  await openRuntimeSession(services, { sessionId: id, ownerEmail: owner, agentName: configuration.agentName, configuration });
  const row = await repository.get(id, owner);
  assert.ok(row);
  assert.ok(row.payload.startsWith("enc:v2:"));
  assert.equal(await repository.get(id, "someone-else@example.test"), null);
  assert.deepEqual((await readRuntimeSession(services, id, owner))?.document.items, []);

  const update = { sessionId: id, ownerEmail: owner, agentName: row.agentName, payload: row.payload, expiresAt: row.expiresAt };
  const raced = await Promise.all([repository.save(update, row.revision), repository.save(update, row.revision)]);
  assert.equal(raced.filter((value) => value !== null).length, 1, "only one session CAS may win");
  const current = (await repository.get(id, owner))!;
  await repository.delete(id, owner);
  assert.equal(await repository.get(id, owner), null);
  assert.equal(await repository.save(update, current.revision), null, "deleted sessions reject late commits");
  assert.equal(await repository.save(update, null), null, "a tombstone prevents resurrection by an old first run");

  const copied = randomUUID();
  const copiedRow = { ...update, sessionId: copied };
  assert.ok(await repository.save(copiedRow, null));
  await assert.rejects(readRuntimeSession(services, copied, owner), "ciphertext is bound to its session identity");
  await repository.delete(copied, owner);

  const expired = randomUUID();
  await repository.save({ ...update, sessionId: expired, expiresAt: new Date(Date.now() - 1000).toISOString() }, null);
  assert.equal(await repository.get(expired, owner), null, "expiry is enforced on reads before the sweep");
  assert.ok(await repository.sweepExpired(new Date()) >= 1);
  console.log("[ok] encrypted SDK Session CAS, ownership, expiry and deletion fencing");
}
