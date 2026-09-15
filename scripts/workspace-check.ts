import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { createWorkspaceCheckpointStore } from "@/infrastructure/db/repositories/workspaceCheckpointStore";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { keys } from "@/infrastructure/db/keys";
import { deleteItem, deletePartition, getItem, putItem } from "@/infrastructure/db/store";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

/** Runs only after integration-check's local `_test` database guard and migration. */
export async function checkWorkspaces(): Promise<void> {
  const suffix = randomUUID();
  const projectName = `workspace-${suffix}`;
  const chatId = `workspace-${suffix}`;
  const sourceChatId = `source-${suffix}`;
  const sourceWorkspaces = new Map<string, string>();
  const owner = "workspace-integration@example.test";
  const now = new Date().toISOString();
  const checkpoints = createWorkspaceCheckpointStore(secretCipher);
  let workspaceId: string | undefined;
  const useCases = createWorkspaceUseCases({ repository, chats, projects, now: () => new Date(), newId: randomUUID,
    idleTtlSeconds: 3600, policy: () => ({ projectName, runtimes: ["command"], checks: [], deploymentWorkflows: [] }) });
  try {
    await projects.create({ name: projectName, displayName: "Workspace integration", description: "",
      ownerEmail: owner, projectType: "agent", createdAt: now, updatedAt: now });
    await chats.create({ chatId, projectName, title: "Workspace integration", ownerEmail: owner, createdAt: now, updatedAt: now });
    await chats.create({ chatId: sourceChatId, projectName, title: "Agent source", ownerEmail: owner, createdAt: now, updatedAt: now });
    const starts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => useCases.startForChat({ projectName, runtime: "command",
      input: { kind: "command", script: `printf request-${index}` } }, owner, sourceChatId)));
    for (const result of starts) if (result.status === "fulfilled") sourceWorkspaces.set(result.value.workspace.id, result.value.workspace.chatId);
    assert.equal(starts.filter(result => result.status === "fulfilled").length, 8, "concurrent starts resolve the same source selection");
    assert.equal(sourceWorkspaces.size, 1, "one source chat cannot create duplicate Workspaces");
    const selectedId = [...sourceWorkspaces.keys()][0]!;
    assert.equal((await chats.get(sourceChatId))?.linkedWorkspaces?.[projectName], selectedId);
    assert.equal((await repository.runs(selectedId, 10)).length, 1, "only the winning start queues its first task");
    const later = await useCases.startForChat({ projectName, runtime: "command", input: { kind: "command", script: "printf later" } }, owner, sourceChatId);
    assert.equal(later.reused, true);
    assert.equal(later.workspace.id, selectedId);
    assert.equal((await repository.runs(selectedId, 10)).length, 1, "another start does not replay or enqueue work");
    const workspace = await useCases.create({ chatId, projectName, title: "General task", runtime: "command" }, owner);
    workspaceId = workspace.id;
    assert.equal(workspace.coding, undefined);
    const input = { kind: "command" as const, script: "printf integration" };
    const runs = await Promise.all(Array.from({ length: 8 }, () => useCases.enqueue(workspace.id, owner, input, "request-0001")));
    assert.equal(new Set(runs.map(run => run.id)).size, 1, "concurrent identical requests admit one run");
    assert.equal((await repository.runs(workspace.id, 10)).length, 1);
    const active = (await repository.get(workspace.id))!;
    const run = runs[0]!;
    const claim = { expectedRevision: active.revision, workspace: { ...active, revision: active.revision + 1 },
      run: { ...run, status: "running" as const, leaseToken: "first-claim", lastEventSeq: 1 },
      events: [{ workspaceId: workspace.id, runId: run.id, seq: 1, createdAt: now,
        data: { kind: "message" as const, text: "claimed" } }] };
    const claims = await Promise.allSettled([repository.write(claim), repository.write(claim)]);
    assert.equal(claims.filter(result => result.status === "fulfilled").length, 1, "only one worker claim wins");
    assert.equal((await repository.events(workspace.id, run.id, 0, 10)).length, 1);
    assert.deepEqual(await repository.events(workspace.id, run.id, 1, 10), []);

    const bytes = Buffer.alloc(WORKSPACE_LIMITS.checkpointChunkBytes + 10, 37);
    await checkpoints.put(workspace.id, "checkpoint-1", bytes, now);
    assert.deepEqual(await checkpoints.get(workspace.id, "checkpoint-1"), bytes);
    const chunkKey = keys.workspaceCheckpointChunk(workspace.id, "checkpoint-1", 0);
    const chunk = (await getItem(chunkKey))!;
    assert.ok(String(chunk.encrypted).startsWith("enc:v2:"), "checkpoint encryption is context-bound AES-GCM");
    const nextChunkKey = keys.workspaceCheckpointChunk(workspace.id, "checkpoint-1", 1);
    await putItem({ ...chunk, ...nextChunkKey });
    await assert.rejects(checkpoints.get(workspace.id, "checkpoint-1"), "copied ciphertext must not decrypt at another chunk address");

    const beforeFinish = (await repository.get(workspace.id))!;
    const finished = { ...beforeFinish, revision: beforeFinish.revision + 1, status: "closed" as const, activeRunId: undefined };
    await repository.write({ expectedRevision: beforeFinish.revision, workspace: finished });
    const gitReview = { expectedRevision: finished.revision, workspace: { ...finished, revision: finished.revision + 1,
      status: "active" as const, activeActionId: "review-1", leaseToken: "git-review", leaseUntil: new Date(Date.now() + 60_000).toISOString() } };
    await assert.rejects(repository.write(gitReview), "worker writes cannot reopen a finished Workspace");
    await assert.rejects(repository.write({ ...gitReview, reopenGitOwner: "foreign@example.test" }), "only the owner can reopen for Git review");
    await repository.write({ ...gitReview, reopenGitOwner: owner });
    assert.equal((await repository.get(workspace.id))?.sessionId, workspace.sessionId, "Git review preserves the Session");

    await useCases.close(workspace.id, owner, true);
    await chats.delete(chatId);
    const closing = (await repository.get(workspace.id))!;
    assert.ok(closing.deleteRequestedAt, "chat deletion cannot remove the compute cleanup record");
    await assert.rejects(repository.write(claim), "late worker cannot overwrite cleanup intent");
    await assert.rejects(useCases.enqueue(workspace.id, owner, input, "request-0002"));
    await repository.write({ expectedRevision: closing.revision, workspace: { ...closing, revision: closing.revision + 1,
      status: "closed", activeRunId: undefined } });
    await assert.rejects(repository.write({ expectedRevision: closing.revision + 1,
      workspace: { ...closing, revision: closing.revision + 2, status: "active" } }), "closed workspace cannot be resurrected");
    await assert.rejects(repository.write({ expectedRevision: closing.revision + 1, reopenGitOwner: owner,
      workspace: { ...closing, revision: closing.revision + 2, status: "active", activeRunId: undefined,
        activeActionId: "review-2", leaseToken: "git-review" } }), "Git review cannot resurrect a deleted Workspace");
    console.log("[ok] Workspace source binding, concurrent start/admission, PostgreSQL CAS, event replay, checkpoints and deletion fencing");
  } finally {
    for (const [id, childChatId] of sourceWorkspaces) {
      await checkpoints.delete(id);
      await deletePartition(keys.workspacePartition(id));
      await deleteItem(keys.workspaceChat(childChatId));
      await chats.delete(childChatId);
    }
    if (await chats.get(sourceChatId)) await chats.delete(sourceChatId);
    if (workspaceId) {
      await checkpoints.delete(workspaceId);
      await deletePartition(keys.workspacePartition(workspaceId));
    }
    await deleteItem(keys.workspaceChat(chatId));
    if (await chats.get(chatId)) await chats.delete(chatId);
    if (await projects.get(projectName)) await projects.delete(projectName);
  }
}
