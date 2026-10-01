import { withConfigurations } from "./agentConfigurations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { createWorkspaceUseCases } from "@/application/workspace/workspaceUseCases";
import { createCodingUseCases, type CodingDeps } from "@/application/coding/codingUseCases";
import { createWorkspaceRuntimeAdapter } from "@/infrastructure/workspace/runtimeAdapters";
import { processWorkspaceContinuation, type WorkspaceContinuationDeps } from "@/application/chat/workspaceContinuation";
import { createWorkspaceTool } from "@/application/workspace/workspaceTool";
import { runtimeSessionFixture } from "./runtimeSessionFixture";
import { FakeChannel, contentChunk, toolCallChunk } from "./fakeChannel";
import type { ChatDeps } from "@/application/chat/deps";
import type { PullRequestInfo } from "@/domain/coding/types";
import { ForbiddenError } from "@/application/errors";

const entropy = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++entropy.sequence).padStart(12, "0")}`,
  randomBytes: (size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUInt32BE(++entropy.sequence);
    return bytes;
  },
}));

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
beforeEach(() => { entropy.sequence = 0; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-15T00:00:00Z")); fake.rows.clear(); });
afterEach(() => vi.useRealTimers());

async function fixture() {
  const f = runtimeSessionFixture();
  f.configuration.parameters.piiFiltering = false;
  const owner = f.scope.ownerEmail;
  const user = { userId: f.scope.userId, email: owner };
  const at = new Date().toISOString();
  fake.seed([{ ...keys.agent("agent"), entityType: "AGENT", name: "agent", displayName: "Agent", description: "",
    ownerEmail: owner, createdAt: at, updatedAt: at }]);
  await chats.create({ chatId: f.scope.sessionId, agentName: "agent", title: "Implement, create PR and merge", ownerEmail: owner, createdAt: at, updatedAt: at });
  await f.run(new FakeChannel([[contentChunk("Waiting for the commit approval")]]), "Commit and push, create a PR, then merge it to main");
  let serial = 0;
  let head = "a".repeat(40);
  let dirty = true;
  const pull: PullRequestInfo = { number: 1, url: "https://example.test/company/repo/pull/1", headSha: "b".repeat(40),
    baseBranch: "main", state: "open", draft: false, ci: "passed" };
  const worktree: import("@/domain/coding/worktree").CodingWorktree = { prepare: async (_id, repo) => ({ ...repo, headSha: head, baseSha: head }),
      review: async () => ({ headSha: head, treeSha: "c".repeat(40), headTreeSha: (dirty ? "d" : "c").repeat(40), fingerprint: `review-${head}-${dirty}`, diff: dirty ? "+change" : "", truncated: false }),
      commit: vi.fn(async () => { dirty = false; head = "b".repeat(40); return head; }), push: vi.fn(async () => {}) };
  const forge: import("@/domain/coding/forge").CodingForge = { releaseTarget: vi.fn(async () => ({ headSha: "e".repeat(40), ci: "passed" as const })),
      createTag: vi.fn(async () => "e".repeat(40)), createRelease: vi.fn(async () => "https://example.test/company/repo/releases/tag/v1.0.0"),
      checkRepository: async () => {}, branches: async () => ({ names: ["main"], hasMore: false }), pullRequest: async () => ({ ...pull }),
      openPullRequest: vi.fn(async () => ({ ...pull })), merge: vi.fn(async () => { pull.state = "merged"; return "c".repeat(40); }),
      reviewMainPush: async () => ({ baseSha: head, ci: "passed" }), pushMain: async () => head, dispatch: async () => ({}) };
  const coding: CodingDeps = {
    members: { getById: async () => ({ id: user.userId, email: owner, name: "Owner", image: null, tier: "member", joinedAt: at, lastLoginAt: null }) }, repository, chats, agents, now: () => new Date(), newId: () => `id-${++serial}`, idleTtlSeconds: 60,
    checkRepository: async () => {}, policy: () => ({ agentName: "agent", repositories: ["company/repo"], runtimes: ["codex"], checks: [], deploymentWorkflows: [] }),
    runtime: kind => createWorkspaceRuntimeAdapter(kind), runTimeoutMs: 1000,
    execute: async (_workspace, work) => { await work(); }, sleep: async () => {},
    provider: { kind: "fake", ensure: async () => ({ externalId: "sandbox-1" }), inspect: async () => "ready",
      execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }), start: async () => {}, operation: async () => ({ id: "", status: "not-started" }),
      output: async () => ({ frames: [], nextOffset: 0 }), cancel: async () => {}, checkpoint: async () => new Uint8Array([1]), restore: async () => {}, destroy: async () => {} },
    checkpoints: { put: async () => {}, get: async () => new Uint8Array([1]), delete: async () => {} },
    coding: () => worktree, forge: () => forge,
  };
  const useCases = createWorkspaceUseCases(coding);
  const workspace = await useCases.create({ chatId: "workspace-chat", agentName: "agent", title: "Work", runtime: "codex",
    repository: "company/repo", baseBranch: "main", createChat: true, sourceChatId: f.scope.sessionId }, owner);
  const git = createCodingUseCases(coding);
  const workspaceTool = createWorkspaceTool({ useCases, authorize: async () => {}, policy: () => coding.policy("agent"),
    workdir: "/workspace/repo", publicBaseUrl: "https://studio.example.test", sleep: async () => {},
    publishGit: (id, caller, action, sourceChatId) => git.publish(id, caller, action, sourceChatId), requestGit: git.request, pullRequest: git.pullRequest, attachRepository: git.attachRepository },
  { user, sourceChatId: f.scope.sessionId, agentName: "agent", ownerEmail: owner, occurrence: "continuation" });
  let channel = new FakeChannel([[contentChunk("Result received")]]);
  const runAgent = vi.fn<ChatDeps["runAgent"]>(async function* (input) {
    for (const chunk of await f.run(channel, "", undefined, { workspaceTool }, { messages: input.messages })) yield chunk;
  });
  const deps: WorkspaceContinuationDeps = { workspaces: repository, authorize: vi.fn(async () => {}), pullRequest: vi.fn(git.pullRequest), now: () => new Date(), sleep: async () => {},
    chat: { chats, agents: withConfigurations(agents, ({ get: async () => f.configuration }).get),  runtimeSessions: f.services, runAgent,
      runLog: { append: vi.fn(async () => {}), read: async () => [] }, documents: { extract: async () => ({ text: "" }) } } };
  const approval = await git.request(workspace.id, user, { kind: "commit-and-push", message: "feat: implement" }, f.scope.sessionId);
  const drain = async () => {
    const queued = await repository.dueContinuations(new Date().toISOString(), 20);
    await Promise.all(queued.map(item => processWorkspaceContinuation(deps, item)));
  };
  return { ...f, user, deps, coding, workspace, git, approval, owner, drain, runAgent, pull,
    setChannel: (next: FakeChannel) => { channel = next; } };
}

describe("Workspace decisions returning to their source chat", () => {
  it("cancels a durable result when another account has replaced the source Session at the same email", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    const queued = (await repository.continuation(f.workspace.id, f.approval.id))!;
    expect(queued.userId).toBe(f.user.userId);
    f.rows.clear();
    f.scope.userId = "replacement-account";
    await f.run(new FakeChannel([[contentChunk("new session")]]), "new request");
    await f.drain();
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("cancelled");
    expect(f.runAgent).not.toHaveBeenCalled();
    expect(f.deps.pullRequest).not.toHaveBeenCalled();
  });

  it("does not allow a continuation revision to change its captured caller ID", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    const queued = (await repository.continuation(f.workspace.id, f.approval.id))!;
    expect(await repository.updateContinuation({ ...queued, userId: "replacement-account", revision: queued.revision + 1 }, queued.revision)).toBe(false);
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.userId).toBe(f.user.userId);
  });

  it("watches inline PR publication without repeating its action result, then resumes only for CI", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await f.drain();
    f.runAgent.mockClear();
    f.pull.ci = "pending";
    const pr = await f.git.publish(f.workspace.id, f.user, { kind: "pull-request", title: "Change", body: "Verified", draft: false }, f.scope.sessionId);
    expect(pr).toMatchObject({ status: "succeeded", authorization: "coding-request", ciWatch: { number: 1, headSha: f.pull.headSha } });
    expect(await repository.continuation(f.workspace.id, pr.id)).toMatchObject({ phase: "ci", status: "waiting-ci", ciWatch: pr.ciWatch });
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    f.pull.ci = "passed";
    vi.setSystemTime(Date.now() + 16_000);
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.runAgent.mock.calls[0]![0].messages[1]!.content as string)).toMatchObject({ event: "workspace_ci_result", status: "succeeded" });
    const messages = await chats.listMessages(f.scope.sessionId);
    expect(messages.filter(row => row.role === "assistant" && row.workspaceAction?.approvalId === pr.id)).toHaveLength(1);
    expect(f.coding.forge("agent").openPullRequest).toHaveBeenCalledTimes(1);
    expect(f.coding.forge("agent").merge).not.toHaveBeenCalled();
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
  });
  it("does not enqueue duplicate continuation for an inline PR whose checks are already settled", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await f.drain();
    f.runAgent.mockClear();
    const pr = await f.git.publish(f.workspace.id, f.user, { kind: "pull-request", title: "Change", body: "Verified", draft: false }, f.scope.sessionId);
    expect(pr.ciWatch).toBeUndefined();
    expect(await repository.continuation(f.workspace.id, pr.id)).toBeNull();
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
  });
  async function waitingForCi() {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await f.drain();
    const pr = await f.git.request(f.workspace.id, f.user, { kind: "pull-request", title: "Change", body: "Validated", draft: false }, f.scope.sessionId);
    f.pull.ci = "pending";
    await f.git.decide(f.workspace.id, f.user, pr.id, true);
    await f.drain();
    expect((await repository.continuation(f.workspace.id, pr.id))?.status).toBe("waiting-ci");
    f.runAgent.mockClear();
    return { ...f, pr };
  }

  it("waits without spending model turns, then resumes the same request to prepare merge when CI completes", async () => {
    const f = await waitingForCi();
    vi.setSystemTime(Date.now() + 16_000);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    f.pull.ci = "passed";
    const merge = { request: { operation: "prepare_git", action: { kind: "merge", pullRequestNumber: 1, headSha: f.pull.headSha } } };
    const channel = new FakeChannel([[toolCallChunk(0, "merge-after-ci", "Workspace", JSON.stringify(merge))], [contentChunk("Merge is ready for approval")]]);
    f.setChannel(channel);
    vi.setSystemTime(Date.now() + 16_000);
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(channel.seenParams[0]?.messages)).toContain("workspace_ci_result");
    expect((await repository.approvals(f.workspace.id, 10))[0]).toMatchObject({ action: { kind: "merge" }, status: "pending" });
    expect(f.coding.forge("agent").merge).not.toHaveBeenCalled();
    const notices = (await chats.listMessages(f.scope.sessionId)).filter(row => row.role === "assistant" && row.workspaceAction?.approvalId === f.pr.id);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ workspaceAction: { event: "ci", status: "succeeded" } });
    expect((await repository.continuation(f.workspace.id, f.pr.id))?.status).toBe("completed");
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "head-changed", "timeout"])("delivers a non-publishable CI outcome when %s", async mode => {
    const f = await waitingForCi();
    if (mode === "failed") f.pull.ci = "failed";
    if (mode === "head-changed") f.pull.headSha = "e".repeat(40);
    vi.setSystemTime(Date.now() + (mode === "timeout" ? 31 * 60_000 : 16_000));
    await f.drain();
    const event = JSON.parse(f.runAgent.mock.calls[0]![0].messages[1]!.content as string);
    expect(event).toMatchObject({ event: "workspace_ci_result", status: "failed" });
    expect(f.coding.forge("agent").merge).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.pr.id))?.status).toBe("completed");
  });

  it("keeps a CI transport failure pending and notifies on its deadline without replaying Git", async () => {
    const f = await waitingForCi();
    vi.mocked(f.deps.pullRequest).mockRejectedValue(new Error("Connection lost"));
    vi.setSystemTime(Date.now() + 16_000);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.pr.id))?.status).toBe("waiting-ci");
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await f.drain();
    expect(JSON.parse(f.runAgent.mock.calls[0]![0].messages[1]!.content as string)).toMatchObject({ status: "failed" });
    expect(f.coding.forge("agent").openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("cancels a CI watch when a newer action owns the workflow", async () => {
    const f = await waitingForCi();
    await f.git.request(f.workspace.id, f.user, { kind: "push" }, f.scope.sessionId);
    vi.setSystemTime(Date.now() + 16_000);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.pr.id))?.status).toBe("cancelled");
  });

  it("continues a confirmed commit into inline PR publication and a separate merge review in the same Session", async () => {
    const f = await fixture();
    const pr = { request: { operation: "prepare_git", action: { kind: "pull-request", title: "Implement", body: "Validated", draft: false } } };
    const merge = { request: { operation: "prepare_git", action: { kind: "merge", pullRequestNumber: 1, headSha: "b".repeat(40) } } };
    const prChannel = new FakeChannel([[toolCallChunk(0, "pr-call", "Workspace", JSON.stringify(pr))],
      [toolCallChunk(0, "merge-call", "Workspace", JSON.stringify(merge))], [contentChunk("Merge review is ready")]]);
    f.setChannel(prChannel);
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await f.drain();
    expect(JSON.stringify(prChannel.seenParams[0]?.messages)).toContain("Commit and push, create a PR, then merge it to main");
    expect(JSON.stringify(prChannel.seenParams[0]?.messages)).toContain("workspace_action_result");
    const prApproval = (await repository.approvals(f.workspace.id, 10)).find(row => row.action.kind === "pull-request")!;
    expect(prApproval).toMatchObject({ status: "succeeded", authorization: "coding-request" });
    expect(prApproval.sourceChatId).toBe(f.scope.sessionId);
    expect(f.coding.forge("agent").openPullRequest).toHaveBeenCalledTimes(1);
    const mergeApproval = (await repository.approvals(f.workspace.id, 10)).find(row => row.action.kind === "merge")!;
    expect(mergeApproval.status).toBe("pending");
    expect(f.coding.forge("agent").merge).not.toHaveBeenCalled();
    f.setChannel(new FakeChannel([[contentChunk("Merged to main")]]));
    await f.git.decide(f.workspace.id, f.user, mergeApproval.id, true);
    await f.drain();
    expect(f.coding.coding("agent").commit).toHaveBeenCalledTimes(1);
    expect(f.coding.forge("agent").openPullRequest).toHaveBeenCalledTimes(1);
    expect(f.coding.forge("agent").merge).toHaveBeenCalledTimes(1);
    expect(await repository.list(f.owner, 20)).toHaveLength(1);
    const messages = await chats.listMessages(f.scope.sessionId);
    expect(messages.filter(row => row.role === "assistant" && row.workspaceAction)).toHaveLength(2);
    expect(messages.some(row => row.content === "Merged to main")).toBe(true);
    expect(messages.some(row => row.role === "user")).toBe(false);
  });

  it("records the outcome atomically and consumes duplicate decisions/deliveries once", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    const queued = (await repository.dueContinuations(new Date().toISOString(), 20))[0]!;
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await Promise.all([processWorkspaceContinuation(f.deps, queued), processWorkspaceContinuation(f.deps, queued)]);
    vi.setSystemTime(Date.now() + 3000);
    await f.drain();
    expect(f.coding.coding("agent").commit).toHaveBeenCalledTimes(1);
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(f.deps.authorize).toHaveBeenCalledWith({ userId: f.scope.userId, email: f.owner }, "agent");
    expect(f.runAgent).toHaveBeenCalledWith(expect.objectContaining({ user: { userId: f.scope.userId, email: f.owner } }));
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("completed");
    expect(await repository.dueContinuations(new Date().toISOString(), 20)).toEqual([]);
  });

  it("waits for the source chat's current run before delivering", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await chats.claimRun(f.scope.sessionId, "original", 0, Math.floor(Date.now() / 1000) + 100);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("pending");
    await chats.releaseRun(f.scope.sessionId, "original");
    vi.setSystemTime(Date.now() + 3000);
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "failed", "uncertain"] as const)("delivers %s outcomes without replaying Git", async status => {
    const f = await fixture();
    if (status === "failed") f.coding.coding("agent").review = async () => { throw new Error("Review failed"); };
    if (status === "uncertain") vi.mocked(f.coding.coding("agent").push).mockRejectedValueOnce(new Error("Connection lost"));
    await f.git.decide(f.workspace.id, f.user, f.approval.id, status !== "rejected");
    await f.drain();
    const input = f.runAgent.mock.calls[0]![0];
    expect(JSON.parse(input.messages[1]!.content as string).status).toBe(status);
    expect(await repository.dueContinuations(new Date().toISOString(), 20)).toEqual([]);
    expect(f.coding.forge("agent").openPullRequest).not.toHaveBeenCalled();
  });

  it.each(["deleted", "revoked"])("cancels delivery when the source is %s", async mode => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    if (mode === "deleted") await chats.delete(f.scope.sessionId);
    else vi.mocked(f.deps.authorize).mockRejectedValueOnce(new ForbiddenError("Access revoked"));
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("cancelled");
  });

  it("never replays a claimed continuation after a worker crash", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    const queued = (await repository.dueContinuations(new Date().toISOString(), 20))[0]!;
    await repository.updateContinuation({ ...queued, revision: 1, status: "running", runId: "lost", dueAt: new Date().toISOString() }, 0);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("failed");
  });

  it("delivers the result without inventing history when the SDK Session is missing", async () => {
    const f = await fixture();
    f.rows.clear();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    const notices = (await chats.listMessages(f.scope.sessionId)).filter(row => row.role === "assistant" && row.workspaceAction);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ warnings: [expect.stringContaining("no saved SDK Session")] });
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("failed");
  });

  it("does not guess a source conversation for directly requested Workspace actions", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, false);
    const manual = await f.git.request(f.workspace.id, f.user, { kind: "commit-and-push", message: "feat: manual request" });
    await f.git.decide(f.workspace.id, f.user, manual.id, true);
    expect(await repository.continuation(f.workspace.id, manual.id)).toBeNull();
    await expect(f.git.request(f.workspace.id, f.user, { kind: "push" }, "foreign-chat")).rejects.toMatchObject({ status: 404 });
  });

  it("does not deliver to a chat that selected a different Workspace", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    const api = createWorkspaceUseCases(f.coding);
    const other = await api.create({ chatId: "other-workspace-chat", createChat: true, agentName: "agent", runtime: "codex", title: "Other" }, f.owner);
    await api.selectForChat(f.scope.sessionId, other.id, "agent", f.owner);
    await f.drain();
    expect(f.runAgent).not.toHaveBeenCalled();
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("cancelled");
  });

  it("keeps unclaimed delivery recoverable after an authorization lookup transport failure", async () => {
    const f = await fixture();
    await f.git.decide(f.workspace.id, f.user, f.approval.id, true);
    vi.mocked(f.deps.authorize).mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(f.drain()).rejects.toThrow("Database unavailable");
    expect((await repository.continuation(f.workspace.id, f.approval.id))?.status).toBe("pending");
    await f.drain();
    expect(f.runAgent).toHaveBeenCalledTimes(1);
  });
});
