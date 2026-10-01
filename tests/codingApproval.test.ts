import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { createCodingUseCases, type CodingDeps } from "@/application/coding/codingUseCases";
import { createWorkspaceRuntimeAdapter } from "@/infrastructure/workspace/runtimeAdapters";
import { handleCodingWebhook } from "@/application/coding/webhook";
import { processWorkspace } from "@/application/workspace/worker";
import { claimWorkspace, WorkspaceLeaseLost, WORKSPACE_LEASE_MS } from "@/application/workspace/workerState";
import type { CodingForge } from "@/domain/coding/forge";
import type { CodingWorktree, WorktreeReview } from "@/domain/coding/worktree";
import type { Workspace } from "@/domain/workspace/types";
import type { PullRequestInfo } from "@/domain/coding/types";
import { CodingMutationRejectedError } from "@/domain/coding/types";
import { createCodingGitHub } from "@/infrastructure/github/codingForge";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const owner = "owner@example.test";
const now = new Date("2026-09-14T00:00:00Z");
const head = "a".repeat(40);
let id: number;
let review: WorktreeReview;
let pull: PullRequestInfo;
let deps: CodingDeps;
let coding: CodingWorktree;
let forge: CodingForge;
let workspace: Workspace;

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); fake.rows.clear(); id = 0;
  review = { headSha: head, treeSha: "b".repeat(40), headTreeSha: "c".repeat(40), fingerprint: "full-tree-fingerprint", diff: "+change", truncated: false };
  pull = { number: 7, url: "https://example.test/company/repo/pull/7", headSha: head, baseBranch: "main", draft: false, state: "open", ci: "passed" };
  coding = { prepare: async (_externalId, repo) => ({ ...repo, baseSha: head, headSha: head }), review: async () => ({ ...review }),
      commit: vi.fn(async () => "d".repeat(40)), push: vi.fn(async () => {}) };
  forge = { releaseTarget: vi.fn(async () => ({ headSha: "e".repeat(40), ci: "passed" as const })),
      createTag: vi.fn(async () => "e".repeat(40)), createRelease: vi.fn(async () => "https://example.test/company/repo/releases/tag/v1.0.0"),
      checkRepository: async () => {}, branches: async () => ({ names: ["main"], hasMore: false }), pullRequest: vi.fn(async () => ({ ...pull })),
      reviewMainPush: vi.fn(async () => ({ baseSha: "e".repeat(40), ci: "none" as const })), pushMain: vi.fn(async () => head),
      openPullRequest: vi.fn(async () => ({ ...pull })), merge: vi.fn(async () => "merged-sha"), dispatch: vi.fn(async () => ({ runId: 99 })) };
  deps = { repository, chats, agents, now: () => now, newId: () => `id-${++id}`, idleTtlSeconds: 60, runTimeoutMs: 60_000,
    checkRepository: vi.fn(async () => {}),
    policy: () => ({ agentName: "demo", repositories: ["company/repo"], runtimes: ["codex"], checks: [], deploymentWorkflows: ["deploy.yml"] }),
    runtime: kind => createWorkspaceRuntimeAdapter(kind), execute: async (_workspace, work) => { await work(); }, sleep: async () => {},
    provider: { kind: "fake", ensure: async () => ({ externalId: "sandbox-1" }), inspect: async () => "ready",
      execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), start: vi.fn(async () => {}), operation: async () => ({ id: "", status: "not-started" }),
      output: async () => ({ frames: [], nextOffset: 0 }), cancel: async () => {}, checkpoint: async () => new Uint8Array([1]), restore: async () => {}, destroy: async () => {} },
    checkpoints: { put: vi.fn(async () => {}), get: async () => new Uint8Array([1]), delete: async () => {} },
    coding: vi.fn(() => coding), forge: vi.fn(() => forge),
  };
  const at = now.toISOString();
  fake.seed([{ ...keys.agent("demo"), entityType: "AGENT", name: "demo", displayName: "Demo", ownerEmail: owner, createdAt: at, updatedAt: at }]);
  await chats.create({ chatId: "chat-1", agentName: "demo", title: "Task", ownerEmail: owner, createdAt: at, updatedAt: at });
  workspace = await createWorkspaceUseCases(deps).create({ chatId: "chat-1", agentName: "demo", title: "Coding", runtime: "codex", repository: "company/repo", baseBranch: "main" }, owner);
});
afterEach(() => {
  try { expect(vi.getTimerCount()).toBe(0); }
  finally { vi.useRealTimers(); }
});

describe("explicit coding action approvals", () => {
  it("publishes a coding request through commit and PR without another decision or duplicate chat continuation", async () => {
    const api = createCodingUseCases(deps);
    const commit = await api.publish(workspace.id, owner, { kind: "commit-and-push", message: "feat: implement request" });
    expect(commit).toMatchObject({ status: "succeeded", authorization: "coding-request", decidedBy: owner });
    expect(coding.push).toHaveBeenCalledExactlyOnceWith("sandbox-1", expect.objectContaining({ headSha: "d".repeat(40) }));
    review.headSha = "d".repeat(40);
    review.treeSha = review.headTreeSha;
    pull.headSha = review.headSha;
    const pr = await api.publish(workspace.id, owner, { kind: "pull-request", title: "Implement request", body: "Verified", draft: false });
    expect(pr).toMatchObject({ status: "succeeded", result: pull.url, authorization: "coding-request" });
    expect((await repository.get(workspace.id))?.pullRequest).toEqual(pull);
    expect(deps.coding).toHaveBeenCalledWith("demo");
    expect(deps.forge).toHaveBeenCalledWith("demo");
    expect((await repository.get(workspace.id))?.activeActionId).toBeUndefined();
    expect(await repository.dueContinuations(now.toISOString(), 20)).toEqual([]);
  });
  it.each([
    { kind: "merge" as const, pullRequestNumber: 7, headSha: head },
    { kind: "push-main" as const },
    { kind: "tag" as const, tag: "v1.0.0" },
    { kind: "release" as const, tag: "v1.0.0", title: "Release", body: "", draft: false, prerelease: false },
    { kind: "deploy" as const, workflow: "deploy.yml", ref: "main", inputs: {} },
  ])("never grants $kind through the coding-request publication path", async action => {
    await expect(createCodingUseCases(deps).publish(workspace.id, owner, action)).rejects.toThrow("explicit confirmation");
    expect(await repository.approvals(workspace.id, 20)).toEqual([]);
    expect(forge.merge).not.toHaveBeenCalled();
    expect(forge.pushMain).not.toHaveBeenCalled();
    expect(forge.dispatch).not.toHaveBeenCalled();
    expect(forge.createTag).not.toHaveBeenCalled();
    expect(forge.createRelease).not.toHaveBeenCalled();
  });
  it.each(["tag", "release"] as const)("confirms %s against the reviewed remote commit and consumes the decision once", async kind => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const action = kind === "tag" ? { kind, tag: "v1.0.0" } : { kind, tag: "v1.0.0", title: "Release", body: "Verified", draft: false, prerelease: false };
    const pending = await api.request(workspace.id, owner, action);
    expect(pending).toMatchObject({ status: "pending", review: { targetSha: "e".repeat(40), ci: "passed" } });
    expect(forge.createTag).not.toHaveBeenCalled();
    expect(forge.createRelease).not.toHaveBeenCalled();
    const result = await api.decide(workspace.id, owner, pending.id, true);
    expect(result.status).toBe("succeeded");
    expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(result);
    if (kind === "tag") expect(forge.createTag).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repository: "company/repo" }), action.tag, "e".repeat(40));
    else expect(forge.createRelease).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repository: "company/repo" }), action, "e".repeat(40));
  });
  it.each(["changed", "failed", "pending"] as const)("blocks tag publication when the target becomes %s after review", async state => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "tag", tag: "v1.0.0" });
    vi.mocked(forge.releaseTarget).mockResolvedValue({ headSha: (state === "changed" ? "f" : "e").repeat(40), ci: state === "changed" ? "passed" : state });
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(forge.createTag).not.toHaveBeenCalled();
  });
  it.each(["refused", "lost-response"] as const)("distinguishes %s during release creation", async mode => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "release", tag: "v1.0.0", title: "Release", body: "", draft: false, prerelease: false });
    vi.mocked(forge.createRelease).mockRejectedValueOnce(mode === "refused" ? new CodingMutationRejectedError("Refused") : new Error("Lost response"));
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe(mode === "refused" ? "failed" : "uncertain");
    expect((await repository.get(workspace.id))?.activeActionId).toBe(mode === "refused" ? undefined : pending.id);
  });
  it("retains an uncertain automatic push and refuses to replay it", async () => {
    review.treeSha = review.headTreeSha;
    vi.mocked(coding.push).mockRejectedValueOnce(new Error("Lost response"));
    const api = createCodingUseCases(deps);
    const result = await api.publish(workspace.id, owner, { kind: "push" });
    expect(result.status).toBe("uncertain");
    await expect(api.publish(workspace.id, owner, { kind: "push" })).rejects.toThrow("busy");
    expect(coding.push).toHaveBeenCalledTimes(1);
  });
  it.each(["review", "commit"] as const)("keeps the action lease during a slow %s without changing approval requirements", async phase => {
    deps.now = () => new Date();
    const api = createCodingUseCases(deps);
    const action = { kind: "commit-and-push" as const, message: "Reviewed change" };
    const delay = () => new Promise(resolve => setTimeout(resolve, WORKSPACE_LEASE_MS + 30_000));
    let work;
    if (phase === "review") {
      vi.spyOn(coding, "review").mockImplementationOnce(async () => { await delay(); return { ...review }; });
      work = api.request(workspace.id, owner, action);
    } else {
      const pending = await api.request(workspace.id, owner, action);
      vi.mocked(coding.commit).mockImplementationOnce(async () => { await delay(); return "d".repeat(40); });
      work = api.decide(workspace.id, owner, pending.id, true);
    }
    const outcome = work.catch(error => error as Error);
    try {
      await vi.advanceTimersByTimeAsync(WORKSPACE_LEASE_MS + 10_000);
      expect(Boolean(await claimWorkspace(deps, workspace.id))).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toMatchObject({ status: phase === "review" ? "pending" : "succeeded" });
      expect(coding.commit).toHaveBeenCalledTimes(phase === "review" ? 0 : 1);
      expect(coding.push).toHaveBeenCalledTimes(phase === "review" ? 0 : 1);
      expect((await repository.get(workspace.id))?.leaseToken).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(WORKSPACE_LEASE_MS);
      await outcome;
    }
  });
  it("does not create a PR after losing the lease during an approved push", async () => {
    deps.now = () => new Date();
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "pull-request", title: "Reviewed change", body: "", draft: false });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(coding.push).mockImplementationOnce(async () => { entered.resolve(); await resume.promise; });
    const decision = api.decide(workspace.id, owner, pending.id, true).catch(error => error as Error);
    try {
      await entered.promise;
      vi.setSystemTime(Date.now() + WORKSPACE_LEASE_MS + 1);
      const replacement = await claimWorkspace(deps, workspace.id);
      expect(replacement).not.toBeNull();
      resume.resolve();
      expect(await decision).toBeInstanceOf(WorkspaceLeaseLost);
      expect(coding.push).toHaveBeenCalledTimes(1);
      expect(forge.openPullRequest).not.toHaveBeenCalled();
      expect((await repository.get(workspace.id))?.leaseToken).toBe(replacement!.token);
      expect((await repository.approval(workspace.id, pending.id))?.status).toBe("executing");
    } finally {
      resume.resolve(); await decision;
    }
  });
  it("allows rejecting a pending review after tool or repository access was revoked, without Git effects", async () => {
    const api = createCodingUseCases(deps);
    const approval = await api.request(workspace.id, owner, { kind: "commit", message: "Reviewed change" });
    deps.authorize = async () => { throw new Error("Workspace tools disabled"); };
    deps.policy = () => ({ agentName: "demo", runtimes: ["codex"], mode: "selected", repositories: [], checks: [], deploymentWorkflows: [] });
    await expect(api.decide(workspace.id, owner, approval.id, true)).rejects.toThrow("Workspace tools disabled");
    expect((await api.decide(workspace.id, owner, approval.id, false)).status).toBe("rejected");
    expect(coding.commit).not.toHaveBeenCalled();
    expect(coding.push).not.toHaveBeenCalled();
  });
  it("rechecks asynchronous repository policy after review and refuses a revoked repository before any Git effect", async () => {
    const api = createCodingUseCases(deps);
    const approval = await api.request(workspace.id, owner, { kind: "commit", message: "feat: add game" });
    deps.policy = async () => ({ agentName: "demo", runtimes: ["codex"], checks: [], deploymentWorkflows: [] });
    await expect(api.decide(workspace.id, owner, approval.id, true)).rejects.toMatchObject({ status: 409 });
    expect(coding.commit).not.toHaveBeenCalled();
    expect(coding.push).not.toHaveBeenCalled();
  });
  it("refreshes saved PR status for the Workspace UI without extending its lifetime or writing unchanged data", async () => {
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, pullRequest: { ...pull, ci: "none" }, revision: workspace.revision + 1 } });
    const before = (await repository.get(workspace.id))!;
    pull.state = "merged";
    const api = createCodingUseCases(deps);
    expect(await api.pullRequest(workspace.id, owner)).toEqual(pull);
    const after = (await repository.get(workspace.id))!;
    expect(after.pullRequest).toEqual(pull);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.dueAt).toBe(before.dueAt);
    expect(after.revision).toBe(before.revision + 1);
    await api.pullRequest(workspace.id, owner);
    expect((await repository.get(workspace.id))?.revision).toBe(after.revision);
  });
  it("does not overwrite a close that races with PR status refresh", async () => {
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, pullRequest: pull, revision: workspace.revision + 1 } });
    vi.mocked(forge.pullRequest).mockImplementationOnce(async () => {
      await createWorkspaceUseCases(deps).close(workspace.id, owner);
      return { ...pull, state: "merged" };
    });
    expect((await createCodingUseCases(deps).pullRequest(workspace.id, owner))?.state).toBe("merged");
    expect((await repository.get(workspace.id))?.status).toBe("closing");
    expect(deps.provider.start).not.toHaveBeenCalled();
  });
  it("restores a closed Workspace for PR review without another native task or Workspace", async () => {
    review.treeSha = review.headTreeSha;
    await createWorkspaceUseCases(deps).close(workspace.id, owner);
    await processWorkspace(deps, workspace.id);
    expect((await repository.get(workspace.id))?.status).toBe("closed");
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "pull-request", title: "Change", body: "", draft: false });
    expect(pending.status).toBe("pending");
    expect((await repository.get(workspace.id))?.status).toBe("active");
    expect((await repository.get(workspace.id))?.sessionId).toBe(workspace.sessionId);
    expect(await repository.list(owner, 20)).toHaveLength(1);
    expect(forge.openPullRequest).not.toHaveBeenCalled();
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
  });
  it("binds a direct main push to the reviewed main head and never creates a PR", async () => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "push-main" });
    expect(pending.review).toMatchObject({ mainHeadSha: "e".repeat(40), ci: "none" });
    expect(forge.pushMain).not.toHaveBeenCalled();
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
    await api.decide(workspace.id, owner, pending.id, true);
    expect(forge.pushMain).toHaveBeenCalledExactlyOnceWith(expect.anything(), head, "e".repeat(40));
    expect(forge.openPullRequest).not.toHaveBeenCalled();
  });
  it("rejects main movement between review and approval", async () => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "push-main" });
    vi.mocked(forge.reviewMainPush).mockResolvedValueOnce({ baseSha: "f".repeat(40), ci: "none" });
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(forge.pushMain).not.toHaveBeenCalled();
  });
  it("exposes a refused main review as an actionable conflict and releases its lease", async () => {
    review.treeSha = review.headTreeSha;
    vi.mocked(forge.reviewMainPush).mockRejectedValueOnce(new CodingMutationRejectedError("Main has diverged; use a pull request"));
    await expect(createCodingUseCases(deps).request(workspace.id, owner, { kind: "push-main" })).rejects.toMatchObject({ status: 409, message: "Main has diverged; use a pull request" });
    expect((await repository.get(workspace.id))?.activeActionId).toBeUndefined();
    expect((await repository.get(workspace.id))?.leaseToken).toBeUndefined();
    expect(forge.pushMain).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps lost main mutation responses uncertain, but releases a definitive refusal (%s)", async definite => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "push-main" });
    vi.mocked(forge.pushMain).mockRejectedValueOnce(definite ? new CodingMutationRejectedError("Branch rule rejected the push") : new Error("Response lost"));
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe(definite ? "failed" : "uncertain");
    expect((await repository.get(workspace.id))?.activeActionId).toBe(definite ? undefined : pending.id);
    await api.decide(workspace.id, owner, pending.id, true);
    expect(forge.pushMain).toHaveBeenCalledTimes(1);
  });
  it("reports absent CI honestly through approved PR merge", async () => {
    review.treeSha = review.headTreeSha; pull.ci = "none";
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, pullRequest: pull, revision: workspace.revision + 1 } });
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "merge", pullRequestNumber: pull.number, headSha: head });
    expect(pending.review.ci).toBe("none");
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
    expect((await repository.get(workspace.id))?.pullRequest?.ci).toBe("none");
  });
  it("commits, checkpoints and pushes the exact new head only after combined approval", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit-and-push", message: "feat: publish" });
    expect(coding.commit).not.toHaveBeenCalled();
    expect(coding.push).not.toHaveBeenCalled();
    vi.mocked(coding.push).mockImplementationOnce(async (_id, repo) => {
      expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
      expect(repo.headSha).toBe("d".repeat(40));
      expect((await repository.get(workspace.id))?.coding?.headSha).toBe(repo.headSha);
    });
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done.status).toBe("succeeded");
    expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(done);
    expect(coding.commit).toHaveBeenCalledTimes(1);
    expect(coding.push).toHaveBeenCalledTimes(1);
    expect(forge.openPullRequest).not.toHaveBeenCalled();
  });
  it("pushes an already committed tree without creating a commit or PR", async () => {
    const api = createCodingUseCases(deps);
    await expect(api.request(workspace.id, owner, { kind: "push" })).rejects.toThrow("Commit workspace changes");
    review.treeSha = review.headTreeSha;
    const pending = await api.request(workspace.id, owner, { kind: "push" });
    expect(coding.push).not.toHaveBeenCalled();
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done).toMatchObject({ status: "succeeded", result: head });
    expect(coding.push).toHaveBeenCalledWith("sandbox-1", expect.objectContaining({ headSha: head, branch: workspace.coding!.branch }));
    expect(coding.commit).not.toHaveBeenCalled();
    expect(forge.openPullRequest).not.toHaveBeenCalled();
  });
  it("retains the committed checkpoint and never replays an uncertain combined push", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit-and-push", message: "feat: publish" });
    vi.mocked(coding.push).mockRejectedValueOnce(new Error("Publication response lost"));
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("uncertain");
    expect((await repository.get(workspace.id))?.coding?.headSha).toBe("d".repeat(40));
    expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
    await api.decide(workspace.id, owner, pending.id, true);
    expect(coding.commit).toHaveBeenCalledTimes(1);
    expect(coding.push).toHaveBeenCalledTimes(1);
  });
  it("does not commit on request, commits once on approval, and never implies push", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "feat: change" });
    expect(pending.status).toBe("pending");
    expect(pending.review.diff).toBe("+change");
    expect(coding.commit).not.toHaveBeenCalled();
    const done = await api.decide(workspace.id, owner, pending.id, true);
    expect(done.status).toBe("succeeded");
    expect(done.decidedBy).toBe(owner);
    expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(done);
    expect(coding.commit).toHaveBeenCalledTimes(1);
    expect(coding.push).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.coding?.headSha).toBe("d".repeat(40));
    expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign owners and a changed full tree", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    await expect(api.decide(workspace.id, "other@example.test", pending.id, true)).rejects.toMatchObject({ status: 404 });
    review.fingerprint = "changed-tree";
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(coding.commit).not.toHaveBeenCalled();
  });
  it("atomically rejects an unapproved review when a new editing task is accepted", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    const run = await createWorkspaceUseCases(deps).enqueue(workspace.id, owner, { kind: "task", prompt: "change files" }, "request-0001");
    expect((await repository.get(workspace.id))?.activeRunId).toBe(run.id);
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("rejected");
    expect(coding.commit).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.activeActionId).toBeUndefined();
  });
  it("does not enqueue a task once an approval has acquired its execution lease", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    const originalReview = coding.review;
    coding.review = async id => {
      await expect(createWorkspaceUseCases(deps).enqueue(workspace.id, owner, { kind: "task", prompt: "change files" }, "request-0001")).rejects.toThrow("busy");
      return originalReview(id);
    };
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
    expect(await repository.runs(workspace.id, 20)).toHaveLength(0);
  });
  it("connects an empty Git-free Workspace without changing its identity or session", async () => {
    const free = await createWorkspaceUseCases(deps).create({ chatId: "free-chat", createChat: true, agentName: "demo", title: "Files", runtime: "codex" }, owner);
    const attached = await createCodingUseCases(deps).attachRepository(free.id, owner, "company/repo", "main");
    expect(attached).toMatchObject({ id: free.id, sessionId: free.sessionId, coding: { repository: "company/repo", baseBranch: "main" } });
    expect(await repository.runs(free.id, 20)).toHaveLength(0);
    expect(deps.checkpoints.put).toHaveBeenCalledTimes(1);
    expect(coding.commit).not.toHaveBeenCalled();
    await expect(createCodingUseCases(deps).attachRepository(free.id, owner, "other/repo", "main")).rejects.toThrow("different repository");
  });
  it("keeps the existing Workspace when repository attachment is refused", async () => {
    const free = await createWorkspaceUseCases(deps).create({ chatId: "free-chat", createChat: true, agentName: "demo", title: "Files", runtime: "codex" }, owner);
    coding.prepare = async () => { throw new Error("workdir is not empty; existing files were kept"); };
    await expect(createCodingUseCases(deps).attachRepository(free.id, owner, "company/repo", "main")).rejects.toThrow("existing files were kept");
    expect((await repository.get(free.id))?.coding).toBeUndefined();
    expect((await repository.get(free.id))?.leaseToken).toBeUndefined();
    expect(deps.checkpoints.put).not.toHaveBeenCalled();
  });
  it("pushes only for an explicitly approved PR and persists its information", async () => {
    review.treeSha = review.headTreeSha;
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "pull-request", title: "Title", body: "Body", draft: true });
    expect(coding.push).not.toHaveBeenCalled();
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("succeeded");
    expect(coding.push).toHaveBeenCalledTimes(1);
    expect(forge.openPullRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ draft: true }));
    expect((await repository.get(workspace.id))?.pullRequest?.number).toBe(7);
  });
  it("requires PR/CI/head review before merge and rechecks CI at approval", async () => {
    review.treeSha = review.headTreeSha;
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1, pullRequest: { ...pull, ci: "pending" } } });
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "merge", pullRequestNumber: 7, headSha: head });
    expect((await repository.get(workspace.id))?.pullRequest?.ci).toBe("passed");
    expect(forge.merge).not.toHaveBeenCalled();
    pull.ci = "failed";
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(forge.merge).not.toHaveBeenCalled();
  });
  it("dispatches only allowed workflows on main and never replays an uncertain dispatch", async () => {
    const api = createCodingUseCases(deps);
    await expect(api.request(workspace.id, owner, { kind: "deploy", workflow: "unlisted.yml", ref: "main", inputs: {} })).rejects.toMatchObject({ status: 400 });
    const pending = await api.request(workspace.id, owner, { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: {} });
    vi.mocked(forge.dispatch).mockRejectedValueOnce(new Error("response lost after dispatch"));
    const result = await api.decide(workspace.id, owner, pending.id, true);
    expect(result.status).toBe("uncertain");
    await api.decide(workspace.id, owner, pending.id, true);
    expect(forge.dispatch).toHaveBeenCalledTimes(1);
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
    expect(forge.merge).toHaveBeenCalledTimes(1);
    expect(forge.merge).toHaveBeenCalledWith(expect.objectContaining({ repository: "company/repo" }), 7, head);
    expect((await repository.get(workspace.id))?.pullRequest?.state).toBe("merged");
  });
  it("retains an uncertain merge approval when GitHub omits the resulting commit", async () => {
    review.treeSha = review.headTreeSha;
    let mergeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
      const path = String(url);
      if (path.endsWith("/merge")) { mergeCalls++; return Response.json({ merged: true }); }
      if (path.includes("/check-runs?")) return Response.json({ total_count: 0, check_runs: [] });
      if (path.includes("/status?")) return Response.json({ total_count: 0, state: "pending" });
      if (path.endsWith("/pulls/7")) return Response.json({ ...pull, html_url: pull.url,
        head: { sha: head, ref: workspace.coding!.branch, repo: { full_name: workspace.coding!.repository } },
        base: { ref: "main", repo: { full_name: workspace.coding!.repository } },
      });
      throw new Error("Unexpected test request");
    }));
    try {
      forge = createCodingGitHub({ apiUrl: "https://example.test/api/v3", webUrl: "https://example.test",
        internalHosts: ["example.test"], getToken: async () => "test-account-token" }, () => now).forge;
      await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, revision: workspace.revision + 1, pullRequest: pull } });
      const api = createCodingUseCases(deps);
      const pending = await api.request(workspace.id, owner, { kind: "merge", pullRequestNumber: 7, headSha: head });
      const result = await api.decide(workspace.id, owner, pending.id, true);
      expect(result.status).toBe("uncertain");
      expect((await repository.get(workspace.id))?.activeActionId).toBe(pending.id);
      expect((await repository.get(workspace.id))?.pullRequest?.state).toBe("open");
      expect(await api.decide(workspace.id, owner, pending.id, true)).toEqual(result);
      expect(mergeCalls).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it("serializes concurrent approval requests before either side effect", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    await Promise.allSettled([api.decide(workspace.id, owner, pending.id, true), api.decide(workspace.id, owner, pending.id, true)]);
    expect(coding.commit).toHaveBeenCalledTimes(1);
  });
  it("refuses effects when chat deletion arrives during approval review", async () => {
    const api = createCodingUseCases(deps);
    const pending = await api.request(workspace.id, owner, { kind: "commit", message: "commit" });
    coding.review = async () => {
      await createWorkspaceUseCases(deps).close(workspace.id, owner, true);
      return review;
    };
    expect((await api.decide(workspace.id, owner, pending.id, true)).status).toBe("failed");
    expect(coding.commit).not.toHaveBeenCalled();
    expect((await repository.get(workspace.id))?.dueAt).toBe(now.toISOString());
  });
  it("records a GitHub delivery once without starting work or approving actions", async () => {
    const raw = JSON.stringify({ repository: { full_name: "Company/Repo" }, pull_request: { number: 7, head: { ref: workspace.coding!.branch } } });
    const results = await Promise.all([handleCodingWebhook(repository, deps.forge, "delivery-0001", raw), handleCodingWebhook(repository, deps.forge, "delivery-0001", raw)]);
    expect(results.filter(result => result.processed)).toHaveLength(1);
    const calls = vi.mocked(forge.pullRequest).mock.calls.length;
    expect(await handleCodingWebhook(repository, deps.forge, "delivery-0001", raw)).toEqual({ processed: false });
    expect(forge.pullRequest).toHaveBeenCalledTimes(calls);
    expect(coding.commit).not.toHaveBeenCalled();
    expect(forge.merge).not.toHaveBeenCalled();
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
    expect(forge.dispatch).not.toHaveBeenCalled();
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
