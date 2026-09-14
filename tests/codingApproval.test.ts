import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { createCodingUseCases, type CodingDeps } from "@/application/coding/codingUseCases";
import { createWorkspaceRuntimeAdapter } from "@/infrastructure/workspace/runtimeAdapters";
import { handleCodingWebhook } from "@/application/coding/webhook";
import { processWorkspace } from "@/application/workspace/worker";
import type { WorktreeReview } from "@/domain/coding/worktree";
import type { Workspace } from "@/domain/workspace/types";
import type { PullRequestInfo } from "@/domain/coding/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const owner = "owner@example.test";
const now = new Date("2026-09-14T00:00:00Z");
const head = "a".repeat(40);
let id: number;
let review: WorktreeReview;
let pull: PullRequestInfo;
let deps: CodingDeps;
let workspace: Workspace;

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear(); id = 0;
  review = { headSha: head, treeSha: "b".repeat(40), headTreeSha: "c".repeat(40), fingerprint: "full-tree-fingerprint", diff: "+change", truncated: false };
  pull = { number: 7, url: "https://example.test/company/repo/pull/7", headSha: head, baseBranch: "main", draft: false, state: "open", ci: "passed" };
  deps = { repository, chats, projects, now: () => now, newId: () => `id-${++id}`, idleTtlSeconds: 60, runTimeoutMs: 60_000,
    policy: () => ({ projectName: "demo", repository: "company/repo", runtimes: ["codex"], checks: [], deploymentWorkflows: ["deploy.yml"] }),
    runtime: kind => createWorkspaceRuntimeAdapter(kind), execute: async (_workspace, work) => { await work(); }, sleep: async () => {},
    provider: { kind: "fake", ensure: async () => ({ externalId: "sandbox-1" }), inspect: async () => "ready",
      execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), start: vi.fn(async () => {}), operation: async () => ({ id: "", status: "not-started" }),
      output: async () => ({ frames: [], nextOffset: 0 }), cancel: async () => {}, checkpoint: async () => new Uint8Array([1]), restore: async () => {}, destroy: async () => {} },
    checkpoints: { put: vi.fn(async () => {}), get: async () => new Uint8Array([1]), delete: async () => {} },
    coding: { prepare: async (_externalId, repo) => ({ ...repo, baseSha: head, headSha: head }), review: async () => ({ ...review }),
      commit: vi.fn(async () => "d".repeat(40)), push: vi.fn(async () => {}) },
    forge: { branches: async () => ({ names: ["main"], hasMore: false }), pullRequest: vi.fn(async () => ({ ...pull })),
      openPullRequest: vi.fn(async () => ({ ...pull })), merge: vi.fn(async () => "merged-sha"), dispatch: vi.fn(async () => ({ runId: 99 })) },
  };
  const at = now.toISOString();
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo", ownerEmail: owner, projectType: "agent", createdAt: at, updatedAt: at }]);
  await chats.create({ chatId: "chat-1", projectName: "demo", title: "Task", ownerEmail: owner, createdAt: at, updatedAt: at });
  workspace = await createWorkspaceUseCases(deps).create({ chatId: "chat-1", projectName: "demo", title: "Coding", runtime: "codex", baseBranch: "main" }, owner);
});
afterEach(() => vi.useRealTimers());

describe("explicit coding action approvals", () => {
  it("commits, checkpoints and pushes the exact new head only after combined approval", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit-and-push", message: "feat: publish" });
    expect(deps.coding.commit).not.toHaveBeenCalled();
    expect(deps.coding.push).not.toHaveBeenCalled();
    vi.mocked(deps.coding.push).mockImplementationOnce(async (_id, repo) => {
      expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
      expect(repo.headSha).toBe("d".repeat(40));
      expect((await repository.get(workspace.id))?.coding?.headSha).toBe(repo.headSha);
    });
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done.status).toBe("succeeded");
    expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(done);
    expect(deps.coding.commit).toHaveBeenCalledTimes(1);
    expect(deps.coding.push).toHaveBeenCalledTimes(1);
    expect(deps.forge.openPullRequest).not.toHaveBeenCalled();
  });
  it("pushes an already committed tree without creating a commit or PR", async () => {
    const api = createCodingUseCases(deps);
    await expect(api.request(workspace.id, owner, { kind: "push" })).rejects.toThrow("Commit workspace changes");
    review.treeSha = review.headTreeSha;
    const pending = await api.request(workspace.id, owner, { kind: "push" });
    expect(deps.coding.push).not.toHaveBeenCalled();
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done).toMatchObject({ status: "succeeded", result: head });
    expect(deps.coding.push).toHaveBeenCalledWith("sandbox-1", expect.objectContaining({ headSha: head, branch: workspace.coding!.branch }));
    expect(deps.coding.commit).not.toHaveBeenCalled();
    expect(deps.forge.openPullRequest).not.toHaveBeenCalled();
  });
  it("retains the committed checkpoint and never replays an uncertain combined push", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit-and-push", message: "feat: publish" });
    vi.mocked(deps.coding.push).mockRejectedValueOnce(new Error("Publication response lost"));
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("uncertain");
    expect((await repository.get(workspace.id))?.coding?.headSha).toBe("d".repeat(40));
    expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
    await api.decide(workspace.id, owner, pending.id, true);
    expect(deps.coding.commit).toHaveBeenCalledTimes(1);
    expect(deps.coding.push).toHaveBeenCalledTimes(1);
  });
  it("does not commit on request, commits once on approval, and never implies push", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "feat: change" });
    expect(pending.status).toBe("pending");
    expect(pending.review.diff).toBe("+change");
    expect(deps.coding.commit).not.toHaveBeenCalled();
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done.status).toBe("succeeded");
    expect(done.decidedBy).toBe(owner);
    expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(done);
    expect(deps.coding.commit).toHaveBeenCalledTimes(1);
    expect(deps.coding.push).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.coding?.headSha).toBe("d".repeat(40));
    expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign owners and a changed full tree", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    await expect(api.decide(workspace.id, "other@example.test", pending.id, true)).rejects.toMatchObject({ status: 404 });
    review.fingerprint = "changed-tree";
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(deps.coding.commit).not.toHaveBeenCalled();
  });
  it("blocks edits while an approval is pending and releases a rejected action", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    await expect(createWorkspaceUseCases(deps).enqueue(workspace.id, owner, { kind: "task", prompt: "change files" }, "request-0001")).rejects.toMatchObject({ status: 409 });
    expect((await api.decide(workspace.id, owner, pending.id, false)).status).toBe("rejected");
    expect((await repository.get(workspace.id))?.activeActionId).toBeUndefined();
  });
  it("pushes only for an explicitly approved PR and persists its information", async () => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "pull-request", title: "Title", body: "Body", draft: true });
    expect(deps.coding.push).not.toHaveBeenCalled();
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
    expect(deps.coding.push).toHaveBeenCalledTimes(1);
    expect(deps.forge.openPullRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ draft: true }));
    expect((await repository.get(workspace.id))?.pullRequest?.number).toBe(7);
  });
  it("requires PR/CI/head review before merge and rechecks CI at approval", async () => {
    review.treeSha = review.headTreeSha;
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1, pullRequest: { ...pull, ci: "pending" } } });
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "merge", pullRequestNumber: 7, headSha: head });
    expect((await repository.get(workspace.id))?.pullRequest?.ci).toBe("passed");
    expect(deps.forge.merge).not.toHaveBeenCalled();
    pull.ci = "failed";
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(deps.forge.merge).not.toHaveBeenCalled();
  });
  it("dispatches only allowed workflows on main and never replays an uncertain dispatch", async () => {
    const api = createCodingUseCases(deps);
    await expect(api.request(workspace.id, owner, { kind: "deploy", workflow: "unlisted.yml", ref: "main", inputs: {} })).rejects.toMatchObject({ status: 400 });
    const pending = await api.request(workspace.id, owner, { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: {} });
    vi.mocked(deps.forge.dispatch).mockRejectedValueOnce(new Error("response lost after dispatch"));
    const result = await api.decide(workspace.id, owner, pending.id, true);
    expect(result.status).toBe("uncertain");
    await api.decide(workspace.id, owner, pending.id, true);
    expect(deps.forge.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.provider.execute).not.toHaveBeenCalled();
    await expect(createWorkspaceUseCases(deps).enqueue(workspace.id, owner, { kind: "task", prompt: "more work" }, "request-0001")).rejects.toMatchObject({ status: 409 });
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("suspended");
  });
  it("merges the reviewed PR once after explicit user approval", async () => {
    review.treeSha = review.headTreeSha;
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1, pullRequest: pull } });
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "merge", pullRequestNumber: 7, headSha: head });
    const result = await api.decide(workspace.id, owner, pending.id, true);
    expect(result.status).toBe("succeeded");
    expect(result.decidedBy).toBe(owner);
    await api.decide(workspace.id, owner, pending.id, true);
    expect(deps.forge.merge).toHaveBeenCalledTimes(1);
    expect(deps.forge.merge).toHaveBeenCalledWith(expect.objectContaining({ repository: "company/repo" }), 7, head);
    expect((await repository.get(workspace.id))?.pullRequest?.state).toBe("merged");
  });
  it("serializes concurrent approval requests before either side effect", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    await Promise.allSettled([api.decide(workspace.id, owner, pending.id, true), api.decide(workspace.id, owner, pending.id, true)]);
    expect(deps.coding.commit).toHaveBeenCalledTimes(1);
  });
  it("refuses effects when chat deletion arrives during approval review", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    deps.coding.review = async () => {
      await createWorkspaceUseCases(deps).close(workspace.id, owner, true);
      return review;
    };
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(deps.coding.commit).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.dueAt).toBe(now.toISOString());
  });
  it("records a GitHub delivery once without starting work or approving actions", async () => {
    const raw = JSON.stringify({ repository: { full_name: "Company/Repo" }, pull_request: { number: 7, head: { ref: workspace.coding!.branch } } });
    const results = await Promise.all([handleCodingWebhook(repository, deps.forge, "delivery-0001", raw), handleCodingWebhook(repository, deps.forge, "delivery-0001", raw)]);
    expect(results.filter(result => result.processed)).toHaveLength(1);
    const calls = vi.mocked(deps.forge.pullRequest).mock.calls.length;
    expect(await handleCodingWebhook(repository, deps.forge, "delivery-0001", raw)).toEqual({ processed: false });
    expect(deps.forge.pullRequest).toHaveBeenCalledTimes(calls);
    expect(deps.coding.commit).not.toHaveBeenCalled();
    expect(deps.forge.merge).not.toHaveBeenCalled();
    expect(deps.provider.start).not.toHaveBeenCalled();
    await expect(handleCodingWebhook(repository, deps.forge, "delivery-0001", raw + " ")).rejects.toMatchObject({ status: 409 });
  });
  it("marks a crashed action uncertain and never dispatches it again", async () => {
    const pending = await createCodingUseCases(deps).request(workspace.id, owner, { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: {} });
    const current = (await repository.get(workspace.id))!;
    await repository.write({ expectedRevision: current.revision, workspace: { ...current, revision: current.revision + 1,
      dueAt: now.toISOString(), leaseToken: "dead-worker", leaseUntil: new Date(now.getTime() - 1).toISOString() },
      approval: { ...pending, status: "executing", operationId: pending.id, decidedBy: owner, decidedAt: now.toISOString() } });
    await processWorkspace(deps, workspace.id);
    expect((await repository.approval(workspace.id, pending.id))?.status).toBe("uncertain");
    expect((await repository.get(workspace.id))?.activeActionId).toBeUndefined();
    expect(deps.forge.dispatch).not.toHaveBeenCalled();
  });
  it("discards pending approval when finishing and permits a new owner follow-up", async () => {
    const pending = await createCodingUseCases(deps).request(workspace.id, owner, { kind: "commit", message: "commit" });
    const api = createWorkspaceUseCases(deps);
    await api.close(workspace.id, owner);
    await processWorkspace(deps, workspace.id);
    expect((await repository.approval(workspace.id, pending.id))?.status).toBe("rejected");
    const next = await api.enqueue(workspace.id, owner, { kind: "task", prompt: "continue" }, "request-0001");
    expect(next.sessionId).toBe(workspace.sessionId);
  });
});
