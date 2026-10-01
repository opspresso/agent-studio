import { webhookCredentialFixture } from "./webhookCredentialFixture";
import { memberFixture } from "./memberFixture";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { processWorkspace, type WorkspaceWorkerDeps } from "@/application/workspace/worker";
import { runWorkspaceWorker } from "@/application/workspace/service";
import { claimWorkspace, WORKSPACE_HEARTBEAT_MS, WORKSPACE_LEASE_MS, WORKSPACE_RETRY_MS } from "@/application/workspace/workerState";
import { createWorkspaceRuntimeAdapter } from "@/infrastructure/workspace/runtimeAdapters";
import type { SandboxOperation, SandboxProvider, SandboxCommand } from "@/domain/workspace/ports";
import type { WorkspaceAgentPolicy } from "@/domain/workspace/policy";
import type { WebhookTrigger } from "@/domain/trigger/types";
import { authorizeWorkspaceExecution } from "@/application/workspace/workspaceAuthorization";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { createWorkspaceTool } from "@/application/workspace/workspaceTool";
import { openReviewWorkspace } from "@/application/workspace/reviewWorkspace";
import { boundWorkspaceEvent } from "@/application/workspace/output";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const owner = "owner@example.test";
let time: number;
let id: number;
let policy: WorkspaceAgentPolicy;
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
  policy = { agentName: "demo", runtimes: ["command", "codex"], checks: [], deploymentWorkflows: [] };
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
  deps = { repository, chats, agents, provider, policy: () => policy, idleTtlSeconds: 60,
    checkRepository: async () => {},
    now: () => new Date(time), newId: () => `id-${++id}`, runTimeoutMs: 10_000,
    runtime: kind => createWorkspaceRuntimeAdapter(kind), execute: async (_workspace, work) => { await work(); },
    sleep: async ms => { time += ms; vi.setSystemTime(time); await onSleep?.(); },
    checkpoints: { put: vi.fn(async (_workspaceId, checkpointId, bytes) => { checkpointRows.set(checkpointId, bytes); }),
      get: vi.fn(async (_workspaceId, checkpointId) => checkpointRows.get(checkpointId) ?? null), delete: vi.fn(async () => { checkpointRows.clear(); }) } };
  const at = new Date(time).toISOString();
  fake.seed([{ ...keys.agent("demo"), entityType: "AGENT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner,
    visibility: "public", createdAt: at, updatedAt: at }]);
  await chats.create({ chatId: "chat-1", agentName: "demo", ownerEmail: owner, title: "Task", createdAt: at, updatedAt: at });
});
afterEach(() => {
  try { expect(vi.getTimerCount()).toBe(0); }
  finally { vi.useRealTimers(); }
});

async function start(runtime: "command" | "codex" = "command") {
  const api = createWorkspaceUseCases(deps);
  const workspace = await api.create({ chatId: "chat-1", agentName: "demo", title: "Task", runtime }, owner);
  const run = await api.enqueue(workspace.id, owner, runtime === "command" ? { kind: "command", script: "echo task" } : { kind: "task", prompt: "do task" }, "request-0001");
  return { api, workspace, run };
}

async function reviewResult(workspaceId: string, runId: string) {
  const target = { repository: "company/repo", number: 1, headSha: "a".repeat(40) };
  const workspace = (await repository.get(workspaceId))!;
  await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1,
    coding: { repository: target.repository, baseBranch: "main", branch: "review", sourceRevision: target.headSha, headSha: target.headSha } } });
  const tool = createWorkspaceTool({ useCases: createWorkspaceUseCases(deps), authorize: async () => {}, policy: () => policy,
    sleep: deps.sleep, publishGit: async () => { throw new Error("Git publication unavailable"); }, requestGit: async () => { throw new Error("unused"); }, pullRequest: async () => undefined,
    attachRepository: async () => { throw new Error("unused"); }, workdir: "/workspace/repo", publicBaseUrl: "https://studio.example.test" },
  { agentName: "demo", ownerEmail: owner, occurrence: "review" });
  const session = await openReviewWorkspace({ tool: async (args, callId) => (args.request as { operation: string }).operation === "start"
    ? { text: JSON.stringify({ workspace_id: workspaceId, workspace_url: "https://studio.example.test/chats/review",
      run_id: "bootstrap", status: "succeeded", head_sha: target.headSha }) } : tool(args, callId),
    state: () => repository.get(workspaceId), close: async () => {}, sleep: deps.sleep,
    verify: async () => ({ headSha: target.headSha, treeSha: "b".repeat(40), headTreeSha: "b".repeat(40), diff: "", truncated: false, fingerprint: "fixture" }) }, target);
  const results: { output: string; output_loss: boolean; truncated: boolean; next_seq: number; has_more: boolean }[] = [];
  let after = 0;
  for (;;) {
    const result = JSON.parse((await session.tool({ request: { operation: "status", workspace_id: workspaceId, run_id: runId, after_seq: after } }, "read")).text) as typeof results[number];
    results.push(result);
    if (!result.has_more) break;
    expect(result.next_seq).toBeGreaterThan(after);
    after = result.next_seq;
  }
  return { session, results };
}

describe("durable workspace worker", () => {
  it("tracks and cancels a cold Pod before it becomes ready without starting native work", async () => {
    const { api, workspace, run } = await start();
    provider.provision = provider.ensure;
    vi.mocked(provider.inspect).mockResolvedValue("provisioning");
    onSleep = async () => {
      onSleep = undefined;
      const current = (await repository.get(workspace.id))!;
      expect(current.sandboxId).toBeDefined();
      await api.cancel(workspace.id, owner);
    };
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("cancelled");
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect((await repository.get(workspace.id))!.sandboxId).toBeUndefined();
  });
  it("adopts a pending Pod after worker shutdown rather than allocating another Pod", async () => {
    const { workspace, run } = await start();
    provider.provision = provider.ensure;
    let pending = true;
    vi.mocked(provider.inspect).mockImplementation(async () => pending ? "provisioning" : "ready");
    const stop = new AbortController();
    onSleep = async () => { onSleep = undefined; stop.abort(); };
    await processWorkspace(deps, workspace.id, stop.signal);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("running");
    onSleep = async () => { onSleep = undefined; pending = false; };
    await processWorkspace(deps, workspace.id);
    expect(provider.ensure).toHaveBeenCalledTimes(1);
    expect(provider.destroy).not.toHaveBeenCalled();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("succeeded");
  });
  it("continues queue polling and heartbeat while sandbox maintenance waits on an external service", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    deps.maintainSandboxes = () => pending;
    const controller = new AbortController();
    const heartbeat = vi.fn(async () => { controller.abort(); release(); });
    await runWorkspaceWorker(deps, controller.signal, 1, heartbeat);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });
  it.each(["command", "codex"] as const)("keeps permanent %s event loss through storage, tool paging and the review publication guard", async runtime => {
    const { workspace, run } = await start(runtime);
    const original = vi.mocked(provider.start).getMockImplementation()!;
    vi.mocked(provider.start).mockImplementationOnce(async (...args) => {
      await original(...args);
      operations.get(run.id)!.frames = [{ stream: "stdout", text: runtime === "command" ? "x".repeat(40_000)
        : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(40_000) } }) + "\n" }];
    });
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))!).toMatchObject({ status: "succeeded", outputLoss: true });
    const events = await repository.events(workspace.id, run.id, 0, 20);
    expect(events.find(event => event.data.kind === (runtime === "command" ? "output" : "message"))?.data)
      .toMatchObject({ text: "x".repeat(4000), outputLoss: true });
    const { session, results } = await reviewResult(workspace.id, run.id);
    expect(results.at(-1)).toMatchObject({ output_loss: true, truncated: true, has_more: false });
    await expect(session.ensureIdle()).rejects.toThrow("output was permanently omitted");
  });
  it("records provider log loss even when the process exits successfully and its retained output is fully paged", async () => {
    const { workspace, run } = await start();
    const original = vi.mocked(provider.operation).getMockImplementation()!;
    vi.mocked(provider.operation).mockImplementation(async (...args) => {
      const operation = await original(...args);
      return operation.status === "succeeded" ? { ...operation, truncated: true } : operation;
    });
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))!).toMatchObject({ status: "succeeded", outputLoss: true });
    const { session, results } = await reviewResult(workspace.id, run.id);
    expect(results.at(-1)?.output_loss).toBe(true);
    await expect(session.ensureIdle()).rejects.toThrow("output was permanently omitted");
  });
  it("persists raw event-limit loss after the warning slot is full and all later writes contain no events", async () => {
    const { workspace, run } = await start();
    const current = (await repository.get(workspace.id))!;
    await repository.write({ expectedRevision: current.revision, workspace: { ...current, revision: current.revision + 1 },
      run: { ...run, lastEventSeq: WORKSPACE_LIMITS.eventsPerRun - 2 } });
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))!).toMatchObject({ status: "succeeded", outputLoss: true,
      lastEventSeq: WORKSPACE_LIMITS.eventsPerRun });
    expect((await repository.events(workspace.id, run.id, WORKSPACE_LIMITS.eventsPerRun - 1, 20))[0]?.data)
      .toMatchObject({ kind: "warning", outputLoss: true });
    const { session, results } = await reviewResult(workspace.id, run.id);
    expect(results.at(-1)).toMatchObject({ output_loss: true, has_more: false });
    await expect(session.ensureIdle()).rejects.toThrow("output was permanently omitted");
  });
  it("marks an omitted native protocol line as permanent output loss", async () => {
    const { workspace, run } = await start("codex");
    const original = vi.mocked(provider.start).getMockImplementation()!;
    vi.mocked(provider.start).mockImplementationOnce(async (...args) => {
      await original(...args);
      operations.get(run.id)!.frames = [{ stream: "stdout", text: "x".repeat(WORKSPACE_LIMITS.diffBytes + 1) }];
    });
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))?.outputLoss).toBe(true);
  });
  it("allows complete raw check output despite a shortened summary cache", async () => {
    policy.checks = [{ name: "test", command: "true" }];
    const { workspace, run } = await start();
    const source = "CHECK RAW ".repeat(8000);
    const original = vi.mocked(provider.start).getMockImplementation()!;
    vi.mocked(provider.start).mockImplementation(async (...args) => {
      await original(...args);
      if (args[1].includes("-check-")) operations.get(args[1])!.frames = Array.from({ length: 40 }, (_, index) =>
        ({ stream: "stdout", text: source.slice(index * 2000, (index + 1) * 2000) }));
    });
    await processWorkspace(deps, workspace.id);
    const result = (await repository.run(workspace.id, run.id))!;
    expect(result.outputLoss).toBeUndefined();
    expect(result.checks[0]).toMatchObject({ status: "passed", truncated: true });
    expect(boundWorkspaceEvent({ kind: "check", check: result.checks[0]! })[0]).toMatchObject({ kind: "check", check: { output: "", truncated: true } });
    const { session, results } = await reviewResult(workspace.id, run.id);
    expect(results.map(page => page.output).join("")).toContain(source);
    expect(results.every(page => !page.output_loss && !page.truncated)).toBe(true);
    await session.ensureIdle();
  });
  it("rechecks the linked messenger user after queue admission and refuses disconnected work", async () => {
    const current = (await agents.get("demo"))!;
    await agents.update({ ...current, telegram: { enabled: true, botToken: "fixture", webhookSecret: "fixture" } }, current.updatedAt);
    let linked = true;
    const grant = { kind: "telegram" as const, agentName: "demo", realm: "telegram", externalId: "1", userId: "caller-id", email: owner };
    deps.authorize = (agentName, email, actor, executionGrant) => authorizeWorkspaceExecution({ apiCredentials: { authorize: async () => null }, agents,
      messagingIdentities: { resolve: async () => linked ? { userId: "caller-id", email: owner } : null },
      webhookCredentials: { authorize: async () => null }, members: { getById: async id => memberFixture({ id, email: owner }) },
      triggers: { get: async () => null }, memberTier: async () => "member", backendReady: () => true, enabled: async () => true }, agentName, email, actor, executionGrant);
    const first = await createWorkspaceUseCases(deps).start({ agentName: "demo", runtime: "command",
      actor: { kind: "telegram", id: "1" }, executionGrant: grant,
      input: { kind: "command", script: "echo task" } }, owner, "messaging-0001");
    expect((await repository.run(first.workspace.id, first.run.id))?.executionGrant).toEqual(grant);
    expect(first.run).not.toHaveProperty("executionGrant");
    linked = false;
    await processWorkspace(deps, first.workspace.id);
    expect(provider.ensure).not.toHaveBeenCalled();
    expect((await repository.run(first.workspace.id, first.run.id))?.status).toBe("failed");
  });

  it("refuses a queued API task after its personal token is revoked", async () => {
    let current = true;
    const grant = { kind: "agent-token" as const, agentName: "demo", userId: "api-user", email: owner, credentialId: "api-token" };
    deps.authorize = (agentName, email, actor, executionGrant) => authorizeWorkspaceExecution({ agents,
      apiCredentials: { authorize: async () => current ? { userId: grant.userId, email: owner, credentialId: grant.credentialId } : null },
      messagingIdentities: { resolve: async () => null }, webhookCredentials: { authorize: async () => null },
      members: { getById: async id => memberFixture({ id, email: owner }) }, triggers: { get: async () => null },
      memberTier: async () => "member", backendReady: () => true, enabled: async () => true }, agentName, email, actor, executionGrant);
    const first = await createWorkspaceUseCases(deps).start({ agentName: "demo", runtime: "command", executionGrant: grant,
      actor: { kind: "agent-token", id: owner }, input: { kind: "command", script: "echo task" } }, owner, "api-0001");
    expect((await repository.run(first.workspace.id, first.run.id))?.executionGrant).toEqual(grant);
    current = false;
    await processWorkspace(deps, first.workspace.id);
    expect(provider.ensure).not.toHaveBeenCalled();
    expect((await repository.run(first.workspace.id, first.run.id))?.status).toBe("failed");
  });
  it("refuses a queued Webhook task when its personal credential is revoked", async () => {
    const webhook: WebhookTrigger = { agentName: "demo", triggerId: "webhook", kind: "webhook", enabled: true,
      description: "", allowConcurrent: false, createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString() };
    const identity = webhookCredentialFixture("demo", "fixture-token", owner);
    const grant = { kind: "webhook" as const, agentName: "demo", triggerId: "webhook", ...identity.principal };
    deps.authorize = (agentName, email, actor, executionGrant) => authorizeWorkspaceExecution({ apiCredentials: { authorize: async () => null }, messagingIdentities: { resolve: async () => null }, agents, webhookCredentials: identity.credentials,
      members: { getById: async id => memberFixture({ id, email: owner }) }, triggers: { get: async () => webhook },
      memberTier: async () => "member", backendReady: () => true, enabled: async () => true }, agentName, email, actor, executionGrant);
    const first = await createWorkspaceUseCases(deps).start({ agentName: "demo", runtime: "command", executionGrant: grant,
      actor: { kind: "webhook", id: "demo:webhook" }, input: { kind: "command", script: "echo task" } }, owner, "webhook-0001");
    expect((await repository.run(first.workspace.id, first.run.id))?.executionGrant).toEqual(grant);
    expect(first.run).not.toHaveProperty("executionGrant");
    identity.revoke();
    await processWorkspace(deps, first.workspace.id);
    expect(provider.ensure).not.toHaveBeenCalled();
    expect((await repository.run(first.workspace.id, first.run.id))?.status).toBe("failed");
  });

  it("refuses revoked execution rights before provisioning an admitted task", async () => {
    const { workspace, run } = await start();
    deps.authorize = vi.fn(async () => { throw new Error("Member access revoked"); });
    await processWorkspace(deps, workspace.id);
    expect(provider.ensure).not.toHaveBeenCalled();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("failed");
    expect((await repository.run(workspace.id, run.id))?.error).toContain("Member access revoked");
  });

  it("retains the queued integration actor through execution, then attributes a console follow-up separately", async () => {
    const api = createWorkspaceUseCases(deps);
    const actor = { kind: "slack" as const, id: "U1" };
    const first = await api.start({ agentName: "demo", runtime: "command", actor,
      input: { kind: "command", script: "echo task" } }, owner, "external-0001");
    const seen: unknown[] = [];
    deps.execute = async (_workspace, work, executionActor) => { seen.push(executionActor); await work(); };
    await processWorkspace(deps, first.workspace.id);
    expect((await repository.run(first.workspace.id, first.run.id))?.status).toBe("succeeded");
    expect(seen).toEqual([actor]);
    const next = await api.enqueue(first.workspace.id, owner, { kind: "command", script: "echo console" }, "console-0001");
    await processWorkspace(deps, first.workspace.id);
    expect((await repository.run(first.workspace.id, next.id))?.status).toBe("succeeded");
    expect(seen).toEqual([actor, undefined]);
  });

  it("rechecks asynchronous repository access before provisioning a queued Git task", async () => {
    policy.mode = "owners";
    policy.repositoryOwners = ["company"];
    deps.policy = async () => policy;
    const api = createWorkspaceUseCases(deps);
    const workspace = await api.create({ chatId: "chat-1", agentName: "demo", title: "New repository", runtime: "codex", repository: "company/new", baseBranch: "main" }, owner);
    const run = await api.enqueue(workspace.id, owner, { kind: "task", prompt: "Implement feature" }, "request-0001");
    policy = { ...policy, mode: "owners", repositoryOwners: [] };
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, run.id))?.status).toBe("failed");
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    await expect(api.enqueue(workspace.id, owner, { kind: "task", prompt: "Try again" }, "request-0002")).rejects.toMatchObject({ status: 409 });
  });
  it("informs each native coding turn about the enforced Git approval boundary", async () => {
    policy.repositories = ["company/repo"];
    const coding: import("@/domain/coding/worktree").CodingWorktree = { prepare: async (_externalId, repo) => ({ ...repo, headSha: "a".repeat(40), baseSha: "a".repeat(40) }),
      review: async () => ({ headSha: "a".repeat(40), headTreeSha: "b".repeat(40), treeSha: "b".repeat(40), fingerprint: "tree", diff: "", truncated: false }),
      commit: vi.fn(async () => "unexpected"), push: vi.fn(async () => {}) };
    deps.coding = vi.fn(() => coding);
    const api = createWorkspaceUseCases(deps);
    const workspace = await api.create({ chatId: "chat-1", agentName: "demo", title: "Git work", runtime: "codex", repository: "company/repo", baseBranch: "main" }, owner);
    await api.enqueue(workspace.id, owner, { kind: "task", prompt: "Commit and push the changes" }, "request-0001");
    await processWorkspace(deps, workspace.id);
    const command = vi.mocked(provider.start).mock.calls[0]![2];
    expect(command.stdin).toContain("/control/git is intentionally protected");
    expect(command.stdin).toContain("Workspace prepare_git");
    expect(command.stdin).toContain("Commit and push the changes");
    expect(deps.coding).toHaveBeenCalledWith("demo");
    expect(coding.commit).not.toHaveBeenCalled();
    expect(coding.push).not.toHaveBeenCalled();
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
  it.each(["ensure", "checkpoint"] as const)("keeps a live worker's lease while %s exceeds one lease interval", async operation => {
    const { workspace, run } = await start();
    deps.now = () => new Date();
    deps.runTimeoutMs = WORKSPACE_LEASE_MS * 3;
    deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const delay = () => new Promise(resolve => setTimeout(resolve, WORKSPACE_LEASE_MS + 30_000));
    if (operation === "ensure") {
      const ensure = vi.mocked(provider.ensure).getMockImplementation()!;
      vi.mocked(provider.ensure).mockImplementationOnce(async workspaceId => { await delay(); return ensure(workspaceId); });
    } else {
      const checkpoint = vi.mocked(provider.checkpoint).getMockImplementation()!;
      vi.mocked(provider.checkpoint).mockImplementationOnce(async externalId => { await delay(); return checkpoint(externalId); });
    }
    const work = processWorkspace(deps, workspace.id);
    try {
      await vi.advanceTimersByTimeAsync(WORKSPACE_LEASE_MS + 10_000);
      expect(provider.ensure).toHaveBeenCalledTimes(1);
      const competingWorker = await claimWorkspace(deps, workspace.id);
      expect(Boolean(competingWorker)).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(work).resolves.toBe(true);
      expect((await repository.run(workspace.id, run.id))?.status).toBe("succeeded");
      expect(provider.start).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(WORKSPACE_LEASE_MS);
      await work;
    }
  });
  it("serializes an in-flight renewal with release and never revives the released lease", async () => {
    const { workspace } = await start();
    deps.now = () => new Date();
    const state = (await claimWorkspace(deps, workspace.id))!;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const write = repository.write.bind(repository);
    const writes = vi.spyOn(repository, "write").mockImplementationOnce(async change => {
      entered.resolve();
      await resume.promise;
      await write(change);
    });
    const scope = state.withHeartbeat(() => done.promise);
    try {
      await vi.advanceTimersByTimeAsync(WORKSPACE_HEARTBEAT_MS);
      await entered.promise;
      const release = state.save({ activeRunId: undefined, leaseToken: undefined, leaseUntil: undefined });
      await Promise.resolve();
      expect(writes).toHaveBeenCalledTimes(1);
      resume.resolve();
      await release;
      expect((await repository.get(workspace.id))?.leaseToken).toBeUndefined();
      const count = writes.mock.calls.length;
      await vi.advanceTimersByTimeAsync(WORKSPACE_LEASE_MS * 2);
      expect(writes).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resume.resolve(); done.resolve(); await scope;
    }
  });
  it("retries a heartbeat CAS conflict without erasing the owner's cancellation", async () => {
    const { api, workspace, run } = await start();
    deps.now = () => new Date();
    const state = (await claimWorkspace(deps, workspace.id))!;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const write = repository.write.bind(repository);
    const writes = vi.spyOn(repository, "write").mockImplementationOnce(async change => {
      entered.resolve(); await resume.promise; await write(change);
    });
    const scope = state.withHeartbeat(() => done.promise);
    try {
      await vi.advanceTimersByTimeAsync(WORKSPACE_HEARTBEAT_MS);
      await entered.promise;
      await api.cancel(workspace.id, owner);
      resume.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toHaveBeenCalledTimes(3);
      expect((await repository.run(workspace.id, run.id))?.cancelRequestedAt).toBeDefined();
      expect((await repository.get(workspace.id))?.leaseToken).toBe(state.token);
    } finally {
      resume.resolve(); done.resolve(); await scope;
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["reclaimed", "renewal-failed", "shutdown"] as const)("starts no further sandbox effects after %s during inspection", async reason => {
    const { api, workspace } = await start();
    await processWorkspace(deps, workspace.id);
    const run = await api.enqueue(workspace.id, owner, { kind: "command", script: "next" }, "request-0002");
    deps.now = () => new Date();
    deps.runTimeoutMs = WORKSPACE_LEASE_MS * 3;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const shutdown = new AbortController();
    vi.mocked(provider.inspect).mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return "stopped"; });
    vi.mocked(provider.ensure).mockClear();
    vi.mocked(provider.start).mockClear();
    const work = processWorkspace(deps, workspace.id, shutdown.signal);
    await entered.promise;
    let replacementToken: string | undefined;
    if (reason === "reclaimed") {
      // A paused process runs no timers; another worker may legitimately claim.
      vi.setSystemTime(Date.now() + WORKSPACE_LEASE_MS + 1);
      replacementToken = (await claimWorkspace(deps, workspace.id))?.token;
      expect(replacementToken).toBeDefined();
    } else if (reason === "renewal-failed") {
      vi.spyOn(repository, "write").mockRejectedValueOnce(new Error("Database unavailable"));
      await vi.advanceTimersByTimeAsync(WORKSPACE_HEARTBEAT_MS);
    } else shutdown.abort();
    resume.resolve();
    await expect(work).resolves.toBe(true);
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(provider.ensure).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect((await repository.run(workspace.id, run.id))?.status).toBe("running");
    if (reason === "reclaimed") expect((await repository.get(workspace.id))?.leaseToken).toBe(replacementToken);
    if (reason === "shutdown") expect((await repository.get(workspace.id))?.leaseToken).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
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
  it.each(["missing", "stopped"] as const)("interrupts a %s Pod and restores the prior native session on the next request", async lostStatus => {
    const { api, workspace } = await start("codex");
    await processWorkspace(deps, workspace.id);
    const checkpointId = (await repository.get(workspace.id))!.checkpointId;
    const next = await api.enqueue(workspace.id, owner, { kind: "task", prompt: "continue" }, "request-0002");
    const originalOutput = vi.mocked(provider.output).getMockImplementation()!;
    let lost = false;
    vi.mocked(provider.output).mockImplementationOnce(async () => { lost = true; throw new Error("Pod connection lost"); });
    const originalOperation = vi.mocked(provider.operation).getMockImplementation()!;
    vi.mocked(provider.operation).mockImplementation(async (...args) => {
      if (lost) throw new Error("Pod unavailable");
      return originalOperation(...args);
    });
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, next.id))?.status).toBe("running");
    time += WORKSPACE_RETRY_MS; vi.setSystemTime(time);
    vi.mocked(provider.inspect).mockResolvedValueOnce(lostStatus);
    await processWorkspace(deps, workspace.id);
    expect((await repository.run(workspace.id, next.id))?.status).toBe("interrupted");
    expect((await repository.get(workspace.id))!.checkpointId).toBe(checkpointId);
    expect(provider.start).toHaveBeenCalledTimes(2);
    lost = false;
    vi.mocked(provider.inspect).mockResolvedValueOnce(lostStatus);
    vi.mocked(provider.output).mockImplementation(originalOutput);
    await api.enqueue(workspace.id, owner, { kind: "task", prompt: "recover" }, "request-0003");
    await processWorkspace(deps, workspace.id);
    expect(provider.restore).toHaveBeenCalledWith(expect.any(String), new Uint8Array([1, 2, 3]));
    expect((await repository.session(workspace.id, workspace.sessionId))?.nativeSessionId).toBe("native-session");
    expect(provider.start).toHaveBeenCalledTimes(3);
    expect(provider.ensure).toHaveBeenCalledTimes(2);
  });
  it("resumes the native session matching restored files rather than newer uncheckpointed metadata", async () => {
    const { api, workspace } = await start("codex");
    await processWorkspace(deps, workspace.id);
    const current = (await repository.get(workspace.id))!;
    const session = (await repository.session(workspace.id, workspace.sessionId))!;
    await repository.write({ expectedRevision: current.revision, workspace: { ...current, revision: current.revision + 1 },
      session: { ...session, nativeSessionId: "uncheckpointed-session" } });
    existing.clear();
    await api.enqueue(workspace.id, owner, { kind: "task", prompt: "recover" }, "request-0002");
    await processWorkspace(deps, workspace.id);
    const command = vi.mocked(provider.start).mock.calls.at(-1)![2];
    expect(command.argv).toContain("native-session");
    expect(command.argv).not.toContain("uncheckpointed-session");
  });
  it("starts a fresh requested native session with a loss warning when compute was lost before its first checkpoint", async () => {
    const { api, workspace } = await start("codex");
    vi.mocked(deps.checkpoints.put).mockRejectedValueOnce(new Error("Checkpoint storage unavailable"));
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))!.checkpointId).toBeUndefined();
    expect((await repository.session(workspace.id, workspace.sessionId))!.nativeSessionId).toBe("native-session");
    existing.clear();
    const requested = await api.enqueue(workspace.id, owner, { kind: "task", prompt: "new request" }, "request-0002");
    await processWorkspace(deps, workspace.id);
    expect(vi.mocked(provider.start).mock.calls.at(-1)![2].argv).not.toContain("resume");
    expect((await repository.events(workspace.id, requested.id, 0, 20)).some(event =>
      event.data.kind === "warning" && event.data.text.includes("no recovery checkpoint"))).toBe(true);
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
