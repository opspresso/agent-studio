import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { processWorkspace, type WorkspaceWorkerDeps } from "@/application/workspace/worker";
import { WORKSPACE_LEASE_MS, WORKSPACE_RETRY_MS } from "@/application/workspace/workerState";
import { createWorkspaceRuntimeAdapter } from "@/infrastructure/workspace/runtimeAdapters";
import type { SandboxOperation, SandboxProvider, SandboxCommand } from "@/domain/workspace/ports";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const owner = "owner@example.test";
let time: number;
let id: number;
let policy: WorkspaceProjectPolicy;
let deps: WorkspaceWorkerDeps;
let operations: Map<string, { status: SandboxOperation["status"]; command: SandboxCommand; frames: { stream: "stdout" | "stderr"; text: string }[]; exitCode: number }>;
let provider: SandboxProvider;
let existing: Set<string>;
let checkpointRows: Map<string, Uint8Array>;
let onSleep: (() => Promise<void>) | undefined;

beforeEach(async () => {
  vi.useFakeTimers();
  time = Date.parse("2026-09-14T00:00:00Z");
  vi.setSystemTime(time);
  id = 0;
  onSleep = undefined;
  fake.rows.clear();
  operations = new Map();
  existing = new Set();
  checkpointRows = new Map();
  policy = { projectName: "demo", runtimes: ["command", "codex"], checks: [], deploymentWorkflows: [] };
  provider = {
    kind: "fake",
    ensure: vi.fn(async () => { const externalId = `sandbox-${++id}`; existing.add(externalId); return { externalId }; }),
    inspect: vi.fn(async externalId => existing.has(externalId) ? "ready" : "missing"),
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    start: vi.fn(async (_externalId, operationId, command) => {
      if (!operations.has(operationId)) operations.set(operationId, { status: "succeeded", command, exitCode: command.stdin === "false" ? 1 : 0,
        frames: [{ stream: "stdout", text: command.argv[0] === "codex" ? '{"type":"thread.started","thread_id":"native-session"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n' : "task output\n" }] });
    }),
    operation: vi.fn(async (_externalId: string, operationId: string): Promise<SandboxOperation> => {
      const operation = operations.get(operationId);
      return operation ? { id: operationId, status: operation.status, exitCode: operation.exitCode } : { id: operationId, status: "not-started" };
    }),
    output: vi.fn(async (_externalId, operationId, offset) => ({ frames: offset === 0 ? operations.get(operationId)?.frames ?? [] : [], nextOffset: 1 })),
    cancel: vi.fn(async (_externalId, operationId) => { const operation = operations.get(operationId); if (operation) operation.status = "failed"; }),
    checkpoint: vi.fn(async () => new Uint8Array([1, 2, 3])),
    restore: vi.fn(async () => {}),
    destroy: vi.fn(async externalId => { existing.delete(externalId); }),
  };
  deps = { repository, chats, projects, provider, policy: () => policy, idleTtlSeconds: 60,
    now: () => new Date(time), newId: () => `id-${++id}`, runTimeoutMs: 10_000,
    runtime: kind => createWorkspaceRuntimeAdapter(kind), execute: async (_workspace, work) => { await work(); },
    sleep: async ms => { time += ms; vi.setSystemTime(time); await onSleep?.(); },
    checkpoints: { put: vi.fn(async (_workspaceId, checkpointId, bytes) => { checkpointRows.set(checkpointId, bytes); }),
      get: vi.fn(async (_workspaceId, checkpointId) => checkpointRows.get(checkpointId) ?? null), delete: vi.fn(async () => { checkpointRows.clear(); }) } };
  const at = new Date(time).toISOString();
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner,
    visibility: "public", projectType: "agent", createdAt: at, updatedAt: at }]);
  await chats.create({ chatId: "chat-1", projectName: "demo", ownerEmail: owner, title: "Task", createdAt: at, updatedAt: at });
});
afterEach(() => vi.useRealTimers());

async function start(runtime: "command" | "codex" = "command") {
  const api = createWorkspaceUseCases(deps);
  const workspace = await api.create({ chatId: "chat-1", projectName: "demo", title: "Task", runtime }, owner);
  const run = await api.enqueue(workspace.id, owner, runtime === "command" ? { kind: "command", script: "echo task" } : { kind: "task", prompt: "do task" }, "request-0001");
  return { api, workspace, run };
}

describe("durable workspace worker", () => {
  it("informs each native coding turn about the enforced Git approval boundary", async () => {
    policy.repository = "company/repo";
    deps.coding = { prepare: async (_externalId, repo) => ({ ...repo, headSha: "a".repeat(40), baseSha: "a".repeat(40) }),
      review: async () => ({ headSha: "a".repeat(40), headTreeSha: "b".repeat(40), treeSha: "b".repeat(40), fingerprint: "tree", diff: "", truncated: false }),
      commit: vi.fn(async () => "unexpected"), push: vi.fn(async () => {}) };
    const api = createWorkspaceUseCases(deps);
    const workspace = await api.create({ chatId: "chat-1", projectName: "demo", title: "Git work", runtime: "codex", baseBranch: "main" }, owner);
    await api.enqueue(workspace.id, owner, { kind: "task", prompt: "Commit and push the changes" }, "request-0001");
    await processWorkspace(deps, workspace.id);
    const command = vi.mocked(provider.start).mock.calls[0]![2];
    expect(command.stdin).toContain("/control/git is intentionally protected");
    expect(command.stdin).toContain("Workspace prepare_git");
    expect(command.stdin).toContain("Commit and push the changes");
    expect(deps.coding.commit).not.toHaveBeenCalled();
    expect(deps.coding.push).not.toHaveBeenCalled();
  });
  it("finishes an already cancelled admission without provisioning or restoring compute", async () => {
    const { api, workspace, run } = await start();
    await api.cancel(workspace.id, owner);
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("cancelled");
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.restore).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.activeRunId).toBeUndefined();
  });

  it.each(["cancel", "close"] as const)("honors %s received during the operation probe before starting a command", async action => {
    const { api, workspace, run } = await start();
    vi.mocked(provider.operation).mockImplementationOnce(async () => {
      await api[action](workspace.id, owner);
      return { id: run.id, status: "not-started" };
    });
    await processWorkspace(deps, workspace.id);
    expect(provider.start).not.toHaveBeenCalled();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("cancelled");
  });

  it("deletes retained state when the owner deletes an already finished Workspace chat", async () => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    await api.close(workspace.id, owner);
    await processWorkspace(deps, workspace.id);
    const closed = (await repository.get(workspace.id))!;
    expect(closed.status).toBe("closed");
    expect(checkpointRows.size).toBeGreaterThan(0);
    const deletion = { ...closed, status: "closing" as const, deleteRequestedAt: deps.now().toISOString(), revision: closed.revision + 1 };
    await expect(repository.write({ workspace: deletion, expectedRevision: closed.revision })).rejects.toMatchObject({ name: "TransactionCancelled" });
    await expect(repository.write({ workspace: deletion, expectedRevision: closed.revision, deleteOwner: "other@example.test" })).rejects.toMatchObject({ name: "TransactionCancelled" });
    await api.close(workspace.id, owner, true);
    await chats.delete("chat-1");
    await expect(api.get(workspace.id, owner)).rejects.toMatchObject({ status: 404 });
    await processWorkspace(deps, workspace.id);
    expect(checkpointRows.size).toBe(0);
    expect((await repository.get(workspace.id))?.status).toBe("closed");
    await expect(api.enqueue(workspace.id, owner, { kind: "command", script: "resume" }, "deleted-request")).rejects.toMatchObject({ status: 404 });
  });
  it("runs a general task, saves output and checkpoint before releasing the run", async () => {
    const { workspace, run } = await start();
    expect(await processWorkspace(deps, workspace.id)).toBe(true);
    const current = (await repository.get(workspace.id))!;
    expect(current.activeRunId).toBeUndefined();
    expect(current.checkpointId).toBeDefined();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("succeeded");
    const events = await repository.events(workspace.id, run.id, 0, 20);
    expect(events.map(event => event.data.kind)).toContain("output");
    expect(events.at(-1)?.data).toMatchObject({ kind: "status", status: "succeeded" });
    expect(provider.destroy).not.toHaveBeenCalled();
  });
  it("continues native sessions and reuses the sandbox for follow-up tasks", async () => {
    const { api, workspace } = await start("codex");
    await processWorkspace(deps, workspace.id);
    expect((await repository.session(workspace.id, workspace.sessionId))?.nativeSessionId).toBe("native-session");
    const next = await api.enqueue(workspace.id, owner, { kind: "task", prompt: "follow up" }, "request-0002");
    await processWorkspace(deps, workspace.id);
    expect(provider.ensure).toHaveBeenCalledTimes(1);
    expect(operations.get(next.id)?.command.argv).toContain("native-session");
    expect(operations.get(next.id)?.command.argv).toContain("resume");
  });
  it("runs explicit test/lint/build checks and preserves failed check results", async () => {
    policy.checks = [{ name: "test", command: "true" }, { name: "lint", command: "false" }, { name: "build", command: "true" }];
    const { workspace, run } = await start();
    await processWorkspace(deps, workspace.id);
    const result = (await repository.run(workspace.id, run.id))!;
    expect(result.status).toBe("failed");
    expect(result.checks.map(check => check.status)).toEqual(["passed", "failed", "passed"]);
    expect(result.checks[1]?.exitCode).toBe(1);
    expect(result.checks[1]?.output).toContain("task output");
  });
  it("checkpoints and deletes idle compute, then restores files into new compute", async () => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    time += 60_000; vi.setSystemTime(time);
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("suspended");
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    await api.enqueue(workspace.id, owner, { kind: "command", script: "continue" }, "request-0002");
    await processWorkspace(deps, workspace.id);
    expect(provider.restore).toHaveBeenCalledTimes(1);
    expect(provider.ensure).toHaveBeenCalledTimes(2);
  });
  it("retains compute when an idle checkpoint cannot be saved", async () => {
    const { workspace } = await start();
    await processWorkspace(deps, workspace.id);
    vi.mocked(provider.checkpoint).mockRejectedValueOnce(new Error("snapshot too large"));
    time += 60_000; vi.setSystemTime(time);
    await processWorkspace(deps, workspace.id);
    expect(provider.destroy).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.status).toBe("suspending");
    time += WORKSPACE_RETRY_MS; vi.setSystemTime(time);
    await processWorkspace(deps, workspace.id);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
  });
  it("reopens a finished workspace for an explicit owner follow-up with the same session", async () => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    await api.close(workspace.id, owner);
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("closed");
    const next = await api.enqueue(workspace.id, owner, { kind: "command", script: "continue finished work" }, "request-0002");
    expect(next.sessionId).toBe(workspace.sessionId);
    await processWorkspace(deps, workspace.id);
    expect(provider.restore).toHaveBeenCalledTimes(1);
    expect((await repository.run(workspace.id, next.id))?.status).toBe("succeeded");
  });
  it("refreshes chat activity and native session retention on subsequent work", async () => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    time += 20_000; vi.setSystemTime(time);
    await api.enqueue(workspace.id, owner, { kind: "command", script: "continue" }, "request-0002");
    expect((await chats.get("chat-1"))?.updatedAt).toBe(new Date(time).toISOString());
    await processWorkspace(deps, workspace.id);
    expect((await repository.session(workspace.id, workspace.sessionId))?.updatedAt).toBe(new Date(time).toISOString());
  });
  it("retries failed deletion and removes checkpoints when the chat was deleted", async () => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    await api.close(workspace.id, owner, true);
    await chats.delete("chat-1");
    vi.mocked(provider.destroy).mockRejectedValueOnce(new Error("daemon unavailable"));
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("closing");
    time += WORKSPACE_RETRY_MS; vi.setSystemTime(time);
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("closed");
    expect(checkpointRows.size).toBe(0);
  });
  it("keeps an actual operation live across an observation failure and adopts it without starting twice", async () => {
    deps.runTimeoutMs = 60_000;
    const { workspace, run } = await start();
    vi.mocked(provider.output).mockImplementationOnce(async () => {
      operations.get(run.id)!.status = "running";
      throw new Error("temporary connection failure");
    });
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.activeRunId).toBe(run.id);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("running");
    operations.get(run.id)!.status = "succeeded";
    time += WORKSPACE_RETRY_MS; vi.setSystemTime(time);
    await processWorkspace(deps, workspace.id);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("succeeded");
  });
  it("does not let two workers claim the same workspace", async () => {
    const { workspace } = await start();
    const results = await Promise.all([processWorkspace(deps, workspace.id), processWorkspace(deps, workspace.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });
  it("uses a persisted stop request while no model output is arriving", async () => {
    const { api, workspace, run } = await start();
    const original = vi.mocked(provider.start).getMockImplementation()!;
    vi.mocked(provider.start).mockImplementationOnce(async (...args) => { await original(...args); operations.get(run.id)!.status = "running"; });
    onSleep = async () => { onSleep = undefined; await api.cancel(workspace.id, owner); };
    await processWorkspace(deps, workspace.id);
    expect(provider.cancel).toHaveBeenCalled();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("cancelled");
  });
  it("does not replay a missing native operation handle", async () => {
    const { workspace, run } = await start();
    vi.mocked(provider.output).mockImplementationOnce(async () => { operations.get(run.id)!.status = "missing"; throw new Error("worker stopped"); });
    await processWorkspace(deps, workspace.id);
    time += WORKSPACE_RETRY_MS; vi.setSystemTime(time);
    deps.runTimeoutMs = WORKSPACE_LEASE_MS;
    await processWorkspace(deps, workspace.id);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("interrupted");
  });
  it("repeats cancellation when close races native process startup", async () => {
    const { api, workspace, run } = await start();
    const original = vi.mocked(provider.start).getMockImplementation()!;
    vi.mocked(provider.start).mockImplementationOnce(async (...args) => { await original(...args); operations.get(run.id)!.status = "running"; });
    vi.mocked(provider.cancel).mockImplementationOnce(async () => {});
    onSleep = async () => { onSleep = undefined; await api.close(workspace.id, owner); };
    await processWorkspace(deps, workspace.id);
    expect(provider.cancel).toHaveBeenCalledTimes(2);
    expect((await repository.get(workspace.id))?.status).toBe("closed");
    expect((await repository.run(workspace.id, run.id))?.status).toBe("cancelled");
  });
});
