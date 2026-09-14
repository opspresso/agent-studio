import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { createWorkspaceCheckpointStore } from "@/infrastructure/db/repositories/workspaceCheckpointStore";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { isGitBranch } from "@/domain/workspace/policy";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import * as store from "@/infrastructure/db/store";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-14T00:00:00.000Z");
const owner = "owner@example.com";
const policy: WorkspaceProjectPolicy = { projectName: "demo", runtimes: ["command", "codex", "claude", "opencode"],
  repository: "company/demo", checks: [], deploymentWorkflows: [] };
let nextId: number;
const useCases = createWorkspaceUseCases({ repository, chats, projects, now: () => now,
  newId: () => `id-${++nextId}`, policy: () => policy, idleTtlSeconds: 3600 });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  nextId = 0;
  fake.rows.clear();
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner,
    visibility: "public", projectType: "agent", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
  await chats.create({ chatId: "chat-1", title: "Task", ownerEmail: owner, projectName: "demo",
    createdAt: now.toISOString(), updatedAt: now.toISOString() });
});
afterEach(() => vi.useRealTimers());

async function create(runtime: "command" | "codex" = "command", coding = false) {
  return useCases.create({ chatId: "chat-1", projectName: "demo", title: "Task", runtime,
    ...(coding ? { baseBranch: "main" } : {}) }, owner);
}

describe("workspace admission and persistence", () => {
  it("atomically starts a new chat and deduplicates concurrent creation retries", async () => {
    const input = { projectName: "demo", runtime: "command" as const, input: { kind: "command" as const, script: "echo hello" } };
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
    await expect(useCases.start({ projectName: "demo", runtime: "codex", input: { kind: "command", script: "echo x" } }, owner, "bad-start-request")).rejects.toMatchObject({ status: 400 });
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

  it("rejects foreign owners, wrong projects, and duplicate workspace attachment", async () => {
    await expect(useCases.create({ chatId: "chat-1", projectName: "demo", title: "Task", runtime: "command" }, "other@example.com"))
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
