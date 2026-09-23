import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocalDatabase } from "./local-database";
import type { WorkspaceWorkerDeps } from "@/application/workspace/worker";

process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@127.0.0.1:5432/agent_studio_test";
assertLocalDatabase(process.env.DATABASE_URL, true);
process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");

async function main() {
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { workspaceRepository: repository } = await import("@/infrastructure/db/repositories/workspaceRepository");
  const { chatRepository: chats } = await import("@/infrastructure/db/repositories/chatRepository");
  const { projectRepository: projects } = await import("@/infrastructure/db/repositories/projectRepository");
  const { usageRepository: usage } = await import("@/infrastructure/db/repositories/usageRepository");
  const { secretCipher } = await import("@/infrastructure/crypto/secretCipher");
  const { createWorkspaceCheckpointStore } = await import("@/infrastructure/db/repositories/workspaceCheckpointStore");
  const { createDockerSandboxProvider } = await import("@/infrastructure/workspace/dockerProvider");
  const { createWorkspaceRuntimeAdapter } = await import("@/infrastructure/workspace/runtimeAdapters");
  const { createWorkspaceUseCases } = await import("@/application/workspace/workspaceUseCases");
  const { processWorkspace } = await import("@/application/workspace/worker");
  const { executeWorkspaceTask } = await import("@/application/execution/runProject");
  const { deleteItem, deletePartition } = await import("@/infrastructure/db/store");
  const { closePool } = await import("@/infrastructure/db/client");
  const { keys } = await import("@/infrastructure/db/keys");
  const provider = createDockerSandboxProvider({ image: process.env.WORKSPACE_SANDBOX_IMAGE || "agent-studio-workspace:agents",
    network: "none", memoryMb: 512, diskMb: 256, cpus: 1 });
  const checkpoints = createWorkspaceCheckpointStore(secretCipher);
  const projectName = `worker-${randomUUID()}`;
  const chatId = randomUUID();
  const ownerEmail = "workspace-worker@example.test";
  const at = new Date().toISOString();
  let offset = 0;
  let workspaceId: string | undefined;
  const containers = new Set<string>();
  const deps: WorkspaceWorkerDeps = {
    repository, chats, projects, provider: { ...provider, ensure: async id => {
      const result = await provider.ensure(id); containers.add(result.externalId); return result;
    } }, checkpoints, now: () => new Date(Date.now() + offset), newId: randomUUID, idleTtlSeconds: 60, runTimeoutMs: 60_000,
    policy: () => ({ projectName, runtimes: ["command"], checks: [{ name: "test", command: "test -s executions.txt" }], deploymentWorkflows: [] }),
    runtime: kind => createWorkspaceRuntimeAdapter(kind),
    execute: (workspace, work) => executeWorkspaceTask({ usage }, projects, workspace, work),
    sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); },
  };
  const api = createWorkspaceUseCases(deps);
  try {
    await projects.create({ name: projectName, displayName: "Workspace worker check", description: "", ownerEmail,
      createdAt: at, updatedAt: at });
    await chats.create({ chatId, projectName, title: "Workspace worker check", ownerEmail, createdAt: at, updatedAt: at });
    const workspace = await api.create({ chatId, projectName, title: "General work", runtime: "command" }, ownerEmail);
    workspaceId = workspace.id;
    const first = await api.enqueue(workspace.id, ownerEmail, { kind: "command", script: "printf once >> executions.txt; sleep 1; printf complete" }, "worker-request-0001");
    const stopping = new AbortController();
    const interrupted: WorkspaceWorkerDeps = { ...deps, provider: { ...deps.provider, start: async (...args) => {
      await provider.start(...args);
      stopping.abort();
    } } };
    await processWorkspace(interrupted, workspace.id, stopping.signal);
    assert.equal((await repository.run(workspace.id, first.id))?.status, "running", "worker stop is not native execution completion");
    await processWorkspace(deps, workspace.id);
    assert.equal((await repository.run(workspace.id, first.id))?.status, "succeeded");
    let current = (await repository.get(workspace.id))!;
    let sandbox = (await repository.sandbox(workspace.id, current.sandboxId!))!;
    const read = () => provider.execute(sandbox.externalId, { argv: ["cat", "executions.txt"], timeoutMs: 5000 });
    assert.equal((await read()).stdout, "once", "a restarted worker adopts the original native operation");
    assert.ok(current.checkpointId);
    assert.equal((await repository.run(workspace.id, first.id))?.checks[0]?.status, "passed");

    const second = await api.enqueue(workspace.id, ownerEmail, { kind: "command", script: "printf twice >> executions.txt" }, "worker-request-0002");
    await processWorkspace(deps, workspace.id);
    assert.equal((await read()).stdout, "oncetwice");
    assert.equal((await repository.run(workspace.id, second.id))?.sessionId, first.sessionId);
    const oldContainer = sandbox.externalId;
    offset += 61_000;
    await processWorkspace(deps, workspace.id);
    assert.equal(await provider.inspect(oldContainer), "missing");
    assert.equal((await repository.get(workspace.id))?.status, "suspended");
    const third = await api.enqueue(workspace.id, ownerEmail, { kind: "command", script: "printf restored >> executions.txt" }, "worker-request-0003");
    await processWorkspace(deps, workspace.id);
    current = (await repository.get(workspace.id))!;
    sandbox = (await repository.sandbox(workspace.id, current.sandboxId!))!;
    assert.notEqual(sandbox.externalId, oldContainer);
    assert.equal((await repository.run(workspace.id, third.id))?.status, "succeeded");
    assert.equal((await read()).stdout, "oncetwicerestored");
    await api.close(workspace.id, ownerEmail);
    await processWorkspace(deps, workspace.id);
    const finished = (await repository.get(workspace.id))!;
    assert.equal(finished.status, "closed");
    assert.ok(finished.checkpointId);
    assert.ok(await checkpoints.get(workspace.id, finished.checkpointId));
    await api.close(workspace.id, ownerEmail, true);
    await chats.delete(chatId);
    await processWorkspace(deps, workspace.id);
    assert.equal((await repository.get(workspace.id))?.status, "closed");
    assert.equal(await provider.inspect(sandbox.externalId), "missing");
    assert.equal(await checkpoints.get(workspace.id, finished.checkpointId), null, "deleting a finished Workspace removes its saved state");
    console.log("[ok] Workspace worker with Docker + PostgreSQL: restart adoption, follow-up, checks, TTL, encrypted restore and chat cleanup");
  } finally {
    for (const id of containers) await provider.destroy(id);
    if (workspaceId) { await checkpoints.delete(workspaceId); await deletePartition(keys.workspacePartition(workspaceId)); }
    await deleteItem(keys.workspaceChat(chatId));
    if (await chats.get(chatId)) await chats.delete(chatId);
    if (await projects.get(projectName)) await projects.delete(projectName);
    await closePool();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
