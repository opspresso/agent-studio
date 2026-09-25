import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { createWorkspaceCheckpointStore } from "@/infrastructure/db/repositories/workspaceCheckpointStore";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { isGitBranch } from "@/domain/workspace/policy";
import type { WorkspaceAgentPolicy } from "@/domain/workspace/policy";
import { CodingRepositoryNotReadyError } from "@/domain/coding/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import * as store from "@/infrastructure/db/store";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-14T00:00:00.000Z");
const owner = "owner@example.com";
const policy: WorkspaceAgentPolicy = { agentName: "demo", runtimes: ["command", "codex", "claude", "opencode"],
  repositories: ["company/demo"], checks: [], deploymentWorkflows: [] };
let nextId: number;
const checkRepository = vi.fn(async (_repository: string, _baseBranch: string) => {});
const useCases = createWorkspaceUseCases({ repository, chats, agents, now: () => now,
  newId: () => `id-${++nextId}`, policy: () => policy, idleTtlSeconds: 3600, checkRepository });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  nextId = 0;
  checkRepository.mockReset();
  fake.rows.clear();
  fake.seed([{ ...keys.agent("demo"), entityType: "AGENT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner,
    visibility: "public", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
  await chats.create({ chatId: "chat-1", title: "Task", ownerEmail: owner, agentName: "demo",
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
});
afterEach(() => vi.useRealTimers());

async function create(runtime: "command" | "codex" = "command", coding = false) {
  return useCases.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime,
    ...(coding ? { repository: "company/demo", baseBranch: "main" } : {}) }, owner);
}

describe("workspace admission and persistence", () => {
  it("does not create a Workspace or source binding for an unavailable repository", async () => {
    checkRepository.mockRejectedValueOnce(new CodingRepositoryNotReadyError("unavailable", "Repository is missing or inaccessible"));
    await expect(useCases.startForChat({ agentName: "demo", runtime: "codex", repository: "company/demo", baseBranch: "main",
      input: { kind: "task", prompt: "Implement an agent" } }, owner, "chat-1")).rejects.toMatchObject({ status: 400, message: expect.stringContaining("missing") });
    expect(await repository.list(owner, 20)).toHaveLength(0);
    expect((await chats.get("chat-1"))?.linkedWorkspaces).toBeUndefined();
  });
  it("checks an uninitialized repository before accepting a recovery run", async () => {
    const workspace = await create("codex", true);
    checkRepository.mockRejectedValueOnce(new CodingRepositoryNotReadyError("empty", "Initialize the repository first"));
    await expect(useCases.enqueue(workspace.id, owner, { kind: "task", prompt: "Retry work" }, "retry-0001")).rejects.toMatchObject({ status: 400 });
    expect(await repository.runs(workspace.id, 20)).toHaveLength(0);
    const run = await useCases.enqueue(workspace.id, owner, { kind: "task", prompt: "Retry work" }, "retry-0001");
    expect(run.status).toBe("queued");
    expect(await repository.list(owner, 20)).toHaveLength(1);
  });
  it("keeps prepared Workspace file work independent of remote repository availability", async () => {
    const workspace = await create("codex", true);
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1,
      coding: { ...workspace.coding!, baseSha: "a".repeat(40) } } });
    checkRepository.mockClear();
    await useCases.enqueue(workspace.id, owner, { kind: "task", prompt: "Run local tests" }, "offline-0001");
    expect(checkRepository).not.toHaveBeenCalled();
  });
  it("creates one Workspace for a source chat under concurrent starts with different tasks", async () => {
    const input = { agentName: "demo", runtime: "command" as const, input: { kind: "command" as const, script: "echo first" } };
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => useCases.startForChat(
      { ...input, input: { ...input.input, script: `echo task-${index}` } }, owner, "chat-1")));
    const ids = new Set(results.map(result => result.workspace.id));
    expect(ids.size).toBe(1);
    const id = results[0]!.workspace.id;
    expect((await chats.get("chat-1"))?.linkedWorkspaces?.demo).toBe(id);
    expect(await repository.list(owner, 20)).toHaveLength(1);
    expect(await repository.runs(id, 20)).toHaveLength(1);
    const again = await useCases.startForChat({ ...input, runtime: "codex", repository: "company/demo", baseBranch: "main",
      input: { kind: "task", prompt: "different mode" } }, owner, "chat-1");
    expect(again).toMatchObject({ reused: true, workspace: { id, runtime: "command" } });
    expect(again.run).toBeUndefined();
    expect(await repository.runs(id, 20)).toHaveLength(1);
  });

  it("retains a source binding across chat updates and rejects cross-owner selection", async () => {
    const sourceBefore = (await chats.get("chat-1"))!;
    const started = await useCases.startForChat({ agentName: "demo", runtime: "command", input: { kind: "command", script: "pwd" } }, owner, "chat-1");
    await chats.update({ ...sourceBefore, title: "Updated after streaming" });
    expect((await useCases.forSourceChat("chat-1", "demo", owner))?.id).toBe(started.workspace.id);
    await expect(useCases.forSourceChat("chat-1", "demo", "foreign@example.test")).rejects.toMatchObject({ status: 404 });
    await expect(useCases.selectForChat("chat-1", started.workspace.id, "other", owner)).rejects.toMatchObject({ status: 404 });
    await expect(useCases.selectForChat("chat-1", started.workspace.id, "demo", "foreign@example.test")).rejects.toMatchObject({ status: 404 });
  });

  it("selects an existing Workspace without creating compute or another run", async () => {
    const existing = await useCases.start({ agentName: "demo", runtime: "command", input: { kind: "command", script: "pwd" } }, owner, "existing-request");
    await useCases.selectForChat("chat-1", existing.workspace.id, "demo", owner);
    const selected = await useCases.startForChat({ agentName: "demo", runtime: "command", input: { kind: "command", script: "echo not queued" } }, owner, "chat-1");
    expect(selected).toMatchObject({ reused: true, workspace: { id: existing.workspace.id } });
    expect(await repository.list(owner, 20)).toHaveLength(1);
    expect(await repository.runs(existing.workspace.id, 20)).toHaveLength(1);
  });

  it("bounds the source chat's agent bindings before creating a Workspace", async () => {
    const key = keys.chat("chat-1");
    const row = (await store.getItem(key))!;
    fake.seed([{ ...row, linkedWorkspaces: Object.fromEntries(Array.from({ length: WORKSPACE_LIMITS.linkedAgents }, (_, index) => [`agent-${index}`, `workspace-${index}`])) }]);
    await expect(useCases.startForChat({ agentName: "demo", runtime: "command", input: { kind: "command", script: "pwd" } }, owner, "chat-1")).rejects.toThrow("agent limit");
    expect(await repository.list(owner, 20)).toHaveLength(0);
  });

  it("rolls back Workspace creation if its source chat is deleted before the transaction", async () => {
    const original = repository.create.bind(repository);
    vi.spyOn(repository, "create").mockImplementationOnce(async (...args) => {
      await chats.delete("chat-1");
      await original(...args);
    });
    await expect(useCases.startForChat({ agentName: "demo", runtime: "command", input: { kind: "command", script: "pwd" } }, owner, "chat-1")).rejects.toThrow();
    expect(await repository.list(owner, 20)).toHaveLength(0);
    expect(await chats.listByOwner(owner, { limit: 20 })).toHaveLength(0);
    vi.restoreAllMocks();
  });
  it("never chooses the first registered repository implicitly", async () => {
    await expect(useCases.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime: "codex", baseBranch: "main" }, owner)).rejects.toMatchObject({ status: 400 });
    expect(checkRepository).not.toHaveBeenCalled();
  });
  it("checks tool and model admission while preserving reads and close after revocation", async () => {
    let enabled = true;
    const authorize = vi.fn(async () => { if (!enabled) throw new Error("tools disabled"); });
    const assertRuntime = vi.fn(async () => {});
    const api = createWorkspaceUseCases({ repository, chats, agents, now: () => now, newId: () => `id-${++nextId}`, policy: () => ({ ...policy, idleTtlSeconds: 300 }), idleTtlSeconds: 1800, authorize, assertRuntime });
    const workspace = await api.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime: "command" }, owner);
    expect(workspace.idleTtlSeconds).toBe(300);
    enabled = false;
    await expect(api.enqueue(workspace.id, owner, { kind: "command", script: "true" }, "revoked-123")).rejects.toThrow("tools disabled");
    expect((await api.get(workspace.id, owner)).workspace.id).toBe(workspace.id);
    await api.close(workspace.id, owner);
    expect(assertRuntime).toHaveBeenCalledTimes(1);
  });
  it("uses an explicitly selected allowed repository and fences later policy removal", async () => {
    const expanded = { ...policy, repositories: ["company/second"] };
    const api = createWorkspaceUseCases({ repository, chats, agents, now: () => now, newId: () => `id-${++nextId}`, policy: () => expanded, idleTtlSeconds: 60, checkRepository });
    const workspace = await api.create({ chatId: "chat-1", agentName: "demo", title: "Second repository", runtime: "codex", repository: "company/second", baseBranch: "main" }, owner);
    expect(workspace.coding?.repository).toBe("company/second");
    expanded.repositories = [];
    await expect(api.enqueue(workspace.id, owner, { kind: "task", prompt: "continue" }, "removed-policy")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a requested repository outside the deployment allowlist", async () => {
    await expect(useCases.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime: "codex", repository: "other/private", baseBranch: "main" }, owner)).rejects.toMatchObject({ status: 400 });
    expect(await repository.forChat("chat-1")).toBeNull();
  });
  it("atomically starts a new chat and deduplicates concurrent creation retries", async () => {
    const input = { agentName: "demo", runtime: "command" as const, input: { kind: "command" as const, script: "echo hello" } };
    const [first, second] = await Promise.all([useCases.start(input, owner, "start-request-01"), useCases.start(input, owner, "start-request-01")]);
    expect(first.workspace.id).toBe(second.workspace.id);
    expect(first.run.id).toBe(second.run.id);
    expect((await chats.get(first.workspace.chatId))?.workspaceId).toBe(first.workspace.id);
    expect(await repository.runs(first.workspace.id, 10)).toHaveLength(1);
    await expect(useCases.start({ ...input, input: { ...input.input, script: "changed" } }, owner, "start-request-01")).rejects.toMatchObject({ status: 409 });
    expect(first.workspace).not.toHaveProperty("leaseToken");
    expect(first.workspace).not.toHaveProperty("creationFingerprint");
    expect(first.run).not.toHaveProperty("requestKey");
  });

  it("rejects mismatched start input without creating a chat or workspace", async () => {
    const before = fake.rows.size;
    await expect(useCases.start({ agentName: "demo", runtime: "codex", input: { kind: "command", script: "echo x" } }, owner, "bad-start-request")).rejects.toMatchObject({ status: 400 });
    expect(fake.rows.size).toBe(before);
  });
  it("creates a general workspace without a repository and keeps its own session", async () => {
    const workspace = await create();
    expect(workspace.coding).toBeUndefined();
    expect(workspace.sessionId).not.toBe(workspace.chatId);
    expect(await repository.forChat("chat-1")).toEqual(workspace);
    expect((await repository.session(workspace.id, workspace.sessionId))?.runtime).toBe("command");
    expect((await chats.get("chat-1"))?.workspaceId).toBe(workspace.id);
    expect(await chats.claimRun("chat-1", "sdk-run", 0, 9999999999)).toBe(false);
  });

  it("supports an agent workspace without Git", async () => {
    expect((await create("codex")).coding).toBeUndefined();
  });

  it("creates a coding workspace with a task branch", async () => {
    const workspace = await create("codex", true);
    expect(workspace.coding).toEqual({ repository: "company/demo", baseBranch: "main", branch: `agent/${workspace.id}` });
  });

  it("rejects foreign owners, wrong agents, and duplicate workspace attachment", async () => {
    await expect(useCases.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime: "command" }, "other@example.com"))
      .rejects.toMatchObject({ status: 404 });
    const workspace = await create();
    await expect(create()).rejects.toMatchObject({ status: 409 });
    await expect(useCases.get(workspace.id, "other@example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("deduplicates concurrent admissions and rejects key reuse with different input", async () => {
    const workspace = await create();
    const input = { kind: "command" as const, script: "printf hello" };
    const [first, second] = await Promise.all([
      useCases.enqueue(workspace.id, owner, input, "request-0001"),
      useCases.enqueue(workspace.id, owner, input, "request-0001"),
    ]);
    expect(first.id).toBe(second.id);
    expect(await repository.runs(workspace.id, 10)).toHaveLength(1);
    await expect(useCases.enqueue(workspace.id, owner, { ...input, script: "different" }, "request-0001"))
      .rejects.toMatchObject({ status: 409 });
    await expect(useCases.enqueue(workspace.id, owner, input, "request-0002")).rejects.toMatchObject({ status: 409 });
  });

  it("continues a later turn in the same workspace and session", async () => {
    const workspace = await create();
    const first = await useCases.enqueue(workspace.id, owner, { kind: "command", script: "echo first" }, "request-0001");
    const active = (await repository.get(workspace.id))!;
    await repository.write({ expectedRevision: active.revision, workspace: { ...active, activeRunId: undefined,
      revision: active.revision + 1 }, run: { ...first, status: "succeeded" } });
    const second = await useCases.enqueue(workspace.id, owner, { kind: "command", script: "echo second" }, "request-0002");
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("atomically fences stale writes and does not append their child events", async () => {
    const workspace = await create();
    const run = await useCases.enqueue(workspace.id, owner, { kind: "command", script: "echo x" }, "request-0001");
    await expect(repository.write({ workspace: { ...workspace, revision: 1 }, expectedRevision: 0,
      run: { ...run, status: "running", lastEventSeq: 1 }, events: [{ workspaceId: workspace.id, runId: run.id,
        seq: 1, createdAt: now.toISOString(), data: { kind: "message", text: "stale" } }] }))
      .rejects.toMatchObject({ name: "TransactionCancelled" });
    expect(await repository.events(workspace.id, run.id, 0, 10)).toEqual([]);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("queued");
  });

  it("retains cleanup intent after chat deletion and refuses new or late work", async () => {
    const workspace = await create();
    await useCases.close(workspace.id, owner, true);
    await chats.delete("chat-1");
    expect((await repository.due(now.toISOString(), 10))[0]?.deleteRequestedAt).toBe(now.toISOString());
    await expect(useCases.enqueue(workspace.id, owner, { kind: "command", script: "echo x" }, "request-0001"))
      .rejects.toMatchObject({ status: 404 });
    const closing = (await repository.get(workspace.id))!;
    await expect(repository.write({ workspace: { ...closing, deleteRequestedAt: undefined, revision: closing.revision + 1 },
      expectedRevision: closing.revision })).rejects.toMatchObject({ name: "TransactionCancelled" });
  });

  it("bounds lists and filters expired rows before applying their limit", async () => {
    const workspace = await create();
    fake.seed([{ ...keys.workspace("expired"), value: workspace, expiresAt: 1,
      GSI1PK: keys.workspaceOwner(owner), GSI1SK: "z" }]);
    expect(await repository.list(owner, 1)).toEqual([workspace]);
    await expect(repository.list(owner, 0)).rejects.toThrow("page limit");
    await expect(repository.list(owner, 999)).rejects.toThrow("page limit");
  });

  it("rejects child scope mismatch and oversized events before writing", async () => {
    const workspace = await create();
    const run = await useCases.enqueue(workspace.id, owner, { kind: "command", script: "true" }, "request-0001");
    const active = (await repository.get(workspace.id))!;
    await expect(repository.write({ workspace: { ...active, revision: active.revision + 1 }, expectedRevision: active.revision,
      run: { ...run, workspaceId: "other" } })).rejects.toThrow("scope mismatch");
    await expect(repository.write({ workspace: { ...active, revision: active.revision + 1 }, expectedRevision: active.revision,
      run: { ...run, lastEventSeq: 1 }, events: [{ workspaceId: workspace.id, runId: run.id, seq: 1,
        createdAt: now.toISOString(), data: { kind: "message", text: "x".repeat(WORKSPACE_LIMITS.eventBytes) } }] }))
      .rejects.toThrow("invalid workspace event");
  });
});

describe("workspace checkpoints", () => {
  const cipher = {
    encrypt: (plain: string, context: string) => JSON.stringify({ context, opaque: plain.split("").reverse().join("") }),
    decrypt: (encrypted: string, context: string) => {
      const value = JSON.parse(encrypted);
      if (value.context !== context) throw new Error("context mismatch");
      return (value.opaque as string).split("").reverse().join("");
    },
  };
  const checkpoints = createWorkspaceCheckpointStore(cipher);

  it("round-trips multiple encrypted chunks independently of the sandbox", async () => {
    const workspace = await create();
    const bytes = new Uint8Array(WORKSPACE_LIMITS.checkpointChunkBytes + 20).fill(42);
    await checkpoints.put(workspace.id, "snapshot-1", bytes, now.toISOString());
    expect(await checkpoints.get(workspace.id, "snapshot-1")).toEqual(Buffer.from(bytes));
    expect(JSON.stringify(await repository.get(workspace.id))).not.toContain("encrypted");
    await checkpoints.delete(workspace.id);
    expect(await checkpoints.get(workspace.id, "snapshot-1")).toBeNull();
  });

  it("detects missing chunks and rejects writes after deletion intent", async () => {
    const workspace = await create();
    await checkpoints.put(workspace.id, "snapshot-1", new Uint8Array([1, 2]), now.toISOString());
    const chunkKey = keys.workspaceCheckpointChunk(workspace.id, "snapshot-1", 0);
    await store.deleteItem(chunkKey);
    await expect(checkpoints.get(workspace.id, "snapshot-1")).rejects.toThrow("incomplete");
    await useCases.close(workspace.id, owner, true);
    await expect(checkpoints.put(workspace.id, "snapshot-2", new Uint8Array([1]), now.toISOString()))
      .rejects.toMatchObject({ name: "TransactionCancelled" });
  });

  it("rejects a checkpoint whose declared size exceeds the restore allocation bound", async () => {
    const workspace = await create();
    fake.seed([{ ...keys.workspaceCheckpoint(workspace.id, "bad"), count: 1, byteLength: WORKSPACE_LIMITS.checkpointBytes + 1 }]);
    await expect(checkpoints.get(workspace.id, "bad")).rejects.toThrow("manifest");
  });
});

it.each(["-main", "../main", "main:evil", "main.lock", "/main", "a//b", "a@{x}", "a b", "a\\b"])
  ("rejects unsafe Git branch %s", branch => expect(isGitBranch(branch)).toBe(false));
it("accepts ordinary branch names", () => expect(isGitBranch("feature/my-work")).toBe(true));
