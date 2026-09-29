import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { agentRepository as agents } from "@/infrastructure/db/repositories/agentRepository";
import { createWorkspaceUseCases, type WorkspaceView } from "@/application/workspace/workspaceUseCases";
import { WORKSPACE_DIRECTORY } from "@/infrastructure/workspace/runtimeAdapters";
import { createWorkspaceTool } from "@/application/workspace/workspaceTool";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { WORKSPACE_TOOL_DEF } from "@/application/llm/workspaceToolDefinition";
import { assembleAgentRun } from "@/application/llm/agentAssembly";
import { runAgent } from "@/application/runtime";
import { FakeChannel, contentChunk, toolCallChunk } from "./fakeChannel";
import type { CodingApproval, CodingAction, PullRequestInfo } from "@/domain/coding/types";
import { workspaceCaller } from "@/application/workspace/workspaceCaller";

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
const now = new Date("2026-09-14T00:00:00Z");
const owner = "owner@example.com";
let serial = 0;
const policy = { agentName: "demo", runtimes: ["command", "codex"] as ("command" | "codex")[], repositories: ["org/repo"], checks: [], deploymentWorkflows: [] };
const useCases = createWorkspaceUseCases({ repository, chats, agents, now: () => now, newId: () => `id-${++serial}`,
  policy: () => policy, idleTtlSeconds: 60, checkRepository: async () => {} });
const authorize = vi.fn(async () => {});
const sleep = vi.fn(async (_ms: number) => {});
const publishGit = vi.fn<(...args: unknown[]) => Promise<CodingApproval>>();
const requestGit = vi.fn<(...args: unknown[]) => Promise<CodingApproval>>();
const attachRepository = vi.fn<(...args: unknown[]) => Promise<WorkspaceView>>();
const pullRequest = vi.fn<(...args: unknown[]) => Promise<PullRequestInfo | undefined>>();
const makeTool = (agentName = "demo", ownerEmail = owner, sourceChatId?: string, occurrence = "parent-run") => createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest, workdir: WORKSPACE_DIRECTORY, publicBaseUrl: "https://studio.example.test", policy: () => policy }, { agentName, ownerEmail, sourceChatId, occurrence });
const invoke = async (request: Record<string, unknown>, callId = "call-start") => JSON.parse((await makeTool()({ request }, callId)).text);
const start = { operation: "start", runtime: "command", repository: null, base_branch: null, task: "printf report > report.txt" };
beforeEach(() => {
  entropy.sequence = 0;
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); serial = 0; fake.rows.clear();
  fake.seed([{ ...keys.agent("demo"), entityType: "AGENT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner, visibility: "public", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
});
afterEach(() => vi.useRealTimers());

describe("Workspace Agent capability", () => {
  it("requests cleanup if a newly created review Workspace cannot admit its first task", async () => {
    const enqueue = vi.spyOn(useCases, "enqueue").mockRejectedValueOnce(new Error("admission refused"));
    try {
      await expect(useCases.start({ agentName: "demo", runtime: "command", repository: "org/repo", baseBranch: "review/head", sourceRevision: "a".repeat(40), input: { kind: "command", script: "true" } }, owner, "review-admission")).rejects.toThrow("admission refused");
      expect((await repository.list(owner, 20))[0]?.status).toBe("closing");
    } finally { enqueue.mockRestore(); }
  });
  it("seals a review Workspace to its provider-verified commit and refuses other workspaces and Git effects", async () => {
    const target = { repository: "org/repo", number: 130, headSha: "a".repeat(40) };
    const tool = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest, workdir: WORKSPACE_DIRECTORY,
      publicBaseUrl: "https://studio.example.test", policy: () => policy }, { agentName: "demo", ownerEmail: owner, occurrence: "review", reviewTarget: target });
    const result = JSON.parse((await tool({ request: start }, "bootstrap")).text);
    expect((await repository.get(result.workspace_id))?.coding).toMatchObject({ repository: target.repository, sourceRevision: target.headSha, baseBranch: `review/${target.headSha}` });
    for (const operation of ["prepare_git", "attach_repository", "create_repository", "use_workspace", "close"]) {
      await expect(tool({ request: { operation } }, "unsafe")).rejects.toThrow("only source reads");
    }
    await expect(tool({ request: { operation: "run", repository: "other/repo", task: "true" } }, "other")).rejects.toThrow("fixed to the verified");
    const unrelated = await invoke(start, "unrelated");
    await expect(tool({ request: { operation: "status", workspace_id: unrelated.workspace_id } }, "read")).rejects.toMatchObject({ status: 404 });
    expect(requestGit).not.toHaveBeenCalled();
  });
  it("selects an owned Workspace for an external run and uses it for options, status and follow-up work", async () => {
    const first = await invoke(start);
    const workspace = (await repository.get(first.workspace_id))!;
    const run = (await repository.run(workspace.id, first.run_id))!;
    await repository.write({ expectedRevision: workspace.revision,
      workspace: { ...workspace, activeRunId: undefined, revision: workspace.revision + 1 }, run: { ...run, status: "succeeded" } });
    const caller = workspaceCaller({ ancestry: ["demo"], actor: { kind: "slack", id: "U1" }, userEmail: owner })!;
    const tool = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest,
      workdir: WORKSPACE_DIRECTORY, policy: () => policy }, { agentName: "demo", ...caller, occurrence: "later-external-run" });
    expect(JSON.parse((await tool({ request: { operation: "use_workspace", workspace_id: workspace.id } }, "select")).text))
      .toMatchObject({ workspace_id: workspace.id, selected: true, task_queued: false });
    expect(JSON.parse((await tool({ request: { operation: "options" } }, "options")).text).current_workspace.workspace_id).toBe(workspace.id);
    expect(JSON.parse((await tool({ request: start }, "start-again")).text)).toMatchObject({ workspace_id: workspace.id, reused: true, task_queued: false });
    const next = JSON.parse((await tool({ request: { operation: "run", task: "echo next" } }, "run")).text);
    expect(next.workspace_id).toBe(workspace.id);
    expect((await repository.run(workspace.id, next.run_id))?.actor).toEqual(caller.actor);
    expect(await repository.list(owner, 20)).toHaveLength(1);
    expect(await repository.runs(workspace.id, 20)).toHaveLength(2);
    await expect(makeTool("demo", "other@example.com")({ request: { operation: "use_workspace", workspace_id: workspace.id } }, "select")).rejects.toMatchObject({ status: 404 });
  });

  it.each(["agent-token", "slack", "telegram", "teams", "schedule", "webhook"] as const)("persists %s provenance while the verified member manages the Workspace", async kind => {
    const caller = workspaceCaller({ ancestry: ["demo"], actor: { kind, id: kind === "agent-token" ? owner : "external-caller" }, userEmail: owner })!;
    const tool = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest,
      workdir: WORKSPACE_DIRECTORY, policy: () => policy }, { agentName: "demo", ...caller, occurrence: "external-run" });
    const first = JSON.parse((await tool({ request: start }, "first")).text);
    const workspace = (await repository.get(first.workspace_id))!;
    expect(workspace.ownerEmail).toBe(owner);
    const run = (await repository.run(workspace.id, first.run_id))!;
    expect(run.actor).toEqual(caller.actor);
    await repository.write({ expectedRevision: workspace.revision,
      workspace: { ...workspace, activeRunId: undefined, revision: workspace.revision + 1 }, run: { ...run, status: "succeeded" } });
    const next = JSON.parse((await tool({ request: { operation: "run", task: "echo next" } }, "next")).text);
    expect((await repository.run(workspace.id, next.run_id))?.actor).toEqual(caller.actor);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("uses a purpose label for history and keeps the script in the queued input", async () => {
    const request = { ...start, title: "보고서 파일 작성" };
    expect(() => createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!)({ request })).not.toThrow();
    const result = await invoke(request);
    expect(result.title).toBe(request.title);
    expect((await repository.get(result.workspace_id))?.title).toBe(request.title);
    expect((await chats.get(result.workspace_path.slice("/chats/".length)))?.title).toBe(request.title);
    expect((await repository.run(result.workspace_id, result.run_id))?.input).toEqual({ kind: "command", script: start.task });
  });

  it("distinguishes new-repository permission from existing access and routes creation through the server", async () => {
    const createRepository = vi.fn(async () => ({ repository: "org/new", status: "created" as const, allowed: true, reused: false,
      result: { repository: "org/new", repositoryId: 42, url: "https://github.example.test/org/new", baseBranch: "main", private: true } }));
    const tool = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest, createRepository,
      workdir: WORKSPACE_DIRECTORY, publicBaseUrl: "https://studio.example.test", policy: () => ({ ...policy, mode: "new" }) },
    { agentName: "demo", ownerEmail: owner, occurrence: "creation-test" });
    const access = JSON.parse((await tool({ request: { operation: "check_repository_access", repository: "org/new" } }, "check")).text);
    expect(access).toMatchObject({ allowed: false, creation_allowed: true, repository_mode: "new" });
    const request = { operation: "create_repository", repository: "org/new", description: "New agent", private: true };
    const validate = createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!);
    expect(() => validate({ request })).not.toThrow();
    expect(() => validate({ request: { ...request, created_at: "2026-09-15" } })).toThrow();
    expect(JSON.parse((await tool({ request }, "create")).text)).toMatchObject({ status: "created", allowed: true,
      repository_url: "https://github.example.test/org/new", base_branch: "main", workspace_created: false, task_queued: false });
    expect(createRepository).toHaveBeenCalledWith("demo", { repository: "org/new", description: "New agent", private: true }, owner);
  });
  it("checks policy before repository creation and returns a real management link without creating compute", async () => {
    const request = { operation: "check_repository_access", repository: "org/new-repo" };
    expect(() => createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!)({ request })).not.toThrow();
    expect(await invoke(request)).toMatchObject({ allowed: false, repository_policy_url: "https://studio.example.test/agents/demo/workspace" });
    expect(await invoke({ ...request, repository: "org/repo" })).toMatchObject({ allowed: true });
    expect(await repository.list(owner, 20)).toHaveLength(0);
    expect(attachRepository).not.toHaveBeenCalled();
    await expect(invoke({ operation: "check_repository", repository: "org/new-repo", base_branch: "main" })).rejects.toThrow("https://studio.example.test/agents/demo/workspace");
  });
  it("checks repository readiness without creating compute or a chat", async () => {
    const request = { operation: "check_repository", repository: "org/repo", base_branch: "main" };
    expect(() => createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!)({ request })).not.toThrow();
    expect(await invoke(request)).toMatchObject({ ready: true, repository: "org/repo" });
    expect(await repository.list(owner, 20)).toHaveLength(0);
    await expect(invoke({ ...request, repository: "other/repo" })).rejects.toMatchObject({ status: 400 });
  });
  it("reuses the source chat across tool IDs and turns, then accepts a minimal follow-up run", async () => {
    await chats.create({ chatId: "source-chat", agentName: "demo", title: "Task", ownerEmail: owner, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const tool = makeTool("demo", owner, "source-chat");
    const first = JSON.parse((await tool({ request: start }, "start-1")).text);
    expect(first.workdir).toBe(WORKSPACE_DIRECTORY);
    expect(first.workspace_url).toBe(`https://studio.example.test${first.workspace_path}`);
    const later = makeTool("demo", owner, "source-chat", "next-user-turn");
    const reused = JSON.parse((await later({ request: { ...start, task: "a different task" } }, "start-2")).text);
    expect(reused).toMatchObject({ workspace_id: first.workspace_id, reused: true, task_queued: false });
    expect(await repository.list(owner, 20)).toHaveLength(1);
    const workspace = (await repository.get(first.workspace_id))!;
    const run = (await repository.run(workspace.id, first.run_id))!;
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, activeRunId: undefined, revision: workspace.revision + 1 }, run: { ...run, status: "succeeded" } });
    const validate = createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!);
    const followUp = { request: { operation: "run", runtime: "command", repository: null, base_branch: null, task: "echo next" } };
    expect(() => validate(followUp)).not.toThrow();
    const next = JSON.parse((await later(followUp, "run-1")).text);
    expect(next.workspace_id).toBe(first.workspace_id);
    expect(await repository.runs(workspace.id, 20)).toHaveLength(2);
    const options = JSON.parse((await later({ request: { operation: "options" } }, "options")).text);
    expect(options.current_workspace.workspace_id).toBe(workspace.id);
    expect(options.current_workspace.repository).toBeNull();
    expect(options).not.toHaveProperty("default_repository");
    expect(options.default_runtime).toBe("command");
  });

  it("requires explicit selection before mutating a different Workspace", async () => {
    await chats.create({ chatId: "source-chat", agentName: "demo", title: "Task", ownerEmail: owner, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const first = JSON.parse((await makeTool("demo", owner, undefined, "first-run")({ request: start }, "first")).text);
    const second = JSON.parse((await makeTool("demo", owner, undefined, "second-run")({ request: start }, "second")).text);
    const tool = makeTool("demo", owner, "source-chat");
    await tool({ request: { operation: "use_workspace", workspace_id: first.workspace_id } }, "select-1");
    await expect(tool({ request: { operation: "run", workspace_id: second.workspace_id, task: "change" } }, "run")).rejects.toThrow("use_workspace");
    const selected = JSON.parse((await tool({ request: { operation: "use_workspace", workspace_id: second.workspace_id } }, "select-2")).text);
    expect(selected).toMatchObject({ selected: true, task_queued: false, workspace_id: second.workspace_id });
    expect(await repository.list(owner, 20)).toHaveLength(2);
  });
  it("rechecks access and deployment policy before every operation", async () => {
    authorize.mockRejectedValueOnce(new Error("Access revoked"));
    await expect(invoke(start)).rejects.toThrow("Access revoked");
    expect(await repository.list(owner, 10)).toHaveLength(0);
    const disabled = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest, workdir: WORKSPACE_DIRECTORY, policy: () => undefined }, { agentName: "demo", ownerEmail: owner, occurrence: "parent" });
    await expect(disabled({ request: { operation: "options" } }, "read")).rejects.toThrow("not enabled");
  });
  it("queues a Git-free task once for a repeated SDK call and reports admission honestly", async () => {
    const first = await invoke(start);
    expect(first.status).toBe("queued");
    expect(first.next).toBe("wait");
    expect(await invoke(start)).toEqual(first);
    expect(await repository.runs(first.workspace_id, 10)).toHaveLength(1);
    expect((await repository.get(first.workspace_id))?.coding).toBeUndefined();
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("also prevents duplicate starts within a stateless execution run", async () => {
    const first = await invoke(start, "call-1");
    const second = await invoke({ ...start, task: "different setup" }, "call-2");
    expect(second).toMatchObject({ workspace_id: first.workspace_id, reused: true, task_queued: false });
    expect(await repository.list(owner, 20)).toHaveLength(1);
    expect(await repository.runs(first.workspace_id, 20)).toHaveLength(1);
  });
  it("rejects an unconfigured repository and foreign owners or agents", async () => {
    await expect(invoke({ ...start, repository: "other/repo", base_branch: "main" })).rejects.toMatchObject({ status: 400 });
    const first = await invoke(start);
    const args = { request: { operation: "status", workspace_id: first.workspace_id, run_id: null, after_seq: 0 } };
    await expect(makeTool("demo", "other@example.com")(args, "read")).rejects.toMatchObject({ status: 404 });
    await expect(makeTool("other")(args, "read")).rejects.toMatchObject({ status: 404 });
  });
  it("waits within a fixed bound and never equates a running task with success", async () => {
    const first = await invoke(start);
    const result = await invoke({ operation: "wait", workspace_id: first.workspace_id, run_id: first.run_id, after_seq: 0 }, "read");
    expect(result.status).toBe("queued");
    expect(result.next).toBe("wait");
    expect(result.has_more).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(8);
  });
  it("pages bounded output without advancing the cursor past undelivered frames", async () => {
    const first = await invoke(start);
    const workspace = (await repository.get(first.workspace_id))!;
    const run = (await repository.run(workspace.id, first.run_id))!;
    const events = Array.from({ length: 12 }, (_, index) => ({ workspaceId: workspace.id, runId: run.id,
      seq: index + 1, createdAt: now.toISOString(), data: { kind: "output" as const, stream: "stdout" as const,
        text: `frame ${index}: ${"한".repeat(1000)}\n` } }));
    await repository.write({ expectedRevision: workspace.revision,
      workspace: { ...workspace, activeRunId: undefined, revision: workspace.revision + 1 },
      run: { ...run, status: "succeeded", lastEventSeq: events.length }, events });
    let after = 0;
    let output = "";
    for (let page = 0; page < events.length; page++) {
      const result = await invoke({ operation: "status", workspace_id: workspace.id, run_id: run.id, after_seq: after }, "read");
      expect(result.truncated).toBe(false);
      expect(result.next_seq).toBeGreaterThan(after);
      output += result.output;
      after = result.next_seq;
      if (!result.has_more) break;
    }
    expect(after).toBe(events.length);
    expect(output).toBe(events.map(event => event.data.text).join(""));
  });
  it("continues a completed task in the same Workspace and native Session", async () => {
    const first = await invoke(start);
    const workspace = (await repository.get(first.workspace_id))!;
    const run = (await repository.run(workspace.id, first.run_id))!;
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, activeRunId: undefined, revision: workspace.revision + 1 }, run: { ...run, status: "succeeded" } });
    const second = await invoke({ operation: "run", workspace_id: workspace.id, task: "cat report.txt" }, "call-follow-up");
    expect(second.workspace_id).toBe(first.workspace_id);
    expect((await repository.run(workspace.id, second.run_id))?.sessionId).toBe(run.sessionId);
  });
  it("offers no approval or credential inputs and only exposes the tool when bound", () => {
    const validate = createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!);
    expect(() => validate({ request: { operation: "approve", workspace_id: "id" } })).toThrow();
    expect(() => validate({ request: { ...start, token: "credential" } })).toThrow();
    expect(() => validate({ request: { operation: "prepare_git", workspace_id: "id", action: { kind: "commit-and-push", message: "feat: change" } } })).not.toThrow();
    expect(() => validate({ request: { operation: "prepare_git", workspace_id: "id", action: { kind: "push", approve: true } } })).toThrow();
    expect(assembleAgentRun({}, {}).tools.some(tool => tool.function.name === "Workspace")).toBe(false);
    expect(assembleAgentRun({ workspaceTool: makeTool() }, {}).tools.some(tool => tool.function.name === "Workspace")).toBe(true);
  });
  it.each<CodingAction>([
    { kind: "merge", pullRequestNumber: 7, headSha: "a".repeat(40) },
    { kind: "tag", tag: "v1.0.0" },
    { kind: "release", tag: "v1.0.0", title: "Release", body: "Verified", draft: false, prerelease: false },
    { kind: "push-main" },
    { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: { environment: "preview" } },
  ])("prepares $kind through the actual tool schema and reuses its pending review without native tasks", async action => {
    const workspace = await useCases.create({ agentName: "demo", chatId: "review-chat", createChat: true,
      title: "Review", runtime: "codex", repository: "org/repo", baseBranch: "main" }, owner);
    const approval: CodingApproval = { id: "approval-1", workspaceId: workspace.id, action, requestedBy: owner,
      requestedAt: now.toISOString(), status: "pending", fingerprint: "reviewed-tree",
      review: { headSha: "a".repeat(40), treeSha: "b".repeat(40), diff: "+change", truncated: false } };
    requestGit.mockImplementationOnce(async () => {
      // PostgreSQL jsonb does not preserve the caller's object key order.
      const stored = { ...approval, action: Object.fromEntries(Object.entries(action).reverse()) as CodingAction };
      await repository.write({ expectedRevision: workspace.revision,
        workspace: { ...workspace, activeActionId: approval.id, revision: workspace.revision + 1 } });
      await repository.write({ expectedRevision: workspace.revision + 1,
        workspace: { ...workspace, activeActionId: approval.id, revision: workspace.revision + 2 }, approval: stored });
      return approval;
    });
    const request = { operation: "prepare_git", workspace_id: workspace.id, action: action.kind === "deploy"
      ? { ...action, inputs: Object.entries(action.inputs).map(([name, value]) => ({ name, value })) } : action };
    expect(() => createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!)({ request })).not.toThrow();
    const result = await invoke(request, "git-call");
    expect(result).toMatchObject({ status: "pending", approval_id: approval.id, approval_path: "/chats/review-chat#actions", approval_url: "https://studio.example.test/chats/review-chat#actions" });
    expect(await invoke(request, "git-call")).toEqual(result);
    expect(requestGit).toHaveBeenCalledExactlyOnceWith(workspace.id, owner, action, undefined);
    expect(await repository.runs(workspace.id, 10)).toHaveLength(0);
    await expect(makeTool("foreign")({ request }, "git-call")).rejects.toMatchObject({ status: 404 });
    await expect(makeTool("demo", "foreign@example.com")({ request }, "git-call")).rejects.toMatchObject({ status: 404 });
    expect(requestGit).toHaveBeenCalledTimes(1);
  });
  it.each<CodingAction>([
    { kind: "commit", message: "feat: change" }, { kind: "commit-and-push", message: "feat: change" },
    { kind: "push" }, { kind: "pull-request", title: "Change", body: "Verified", draft: false },
  ])("executes $kind inline and returns no approval link", async action => {
    const workspace = await useCases.create({ agentName: "demo", chatId: "publish-chat", createChat: true,
      title: "Publish", runtime: "codex", repository: "org/repo", baseBranch: "main" }, owner);
    publishGit.mockResolvedValueOnce({ id: "publication", workspaceId: workspace.id, action, requestedBy: owner,
      requestedAt: now.toISOString(), status: "succeeded", authorization: "coding-request", result: "Published",
      fingerprint: "tree", review: { headSha: "a".repeat(40), treeSha: "b".repeat(40), diff: "", truncated: false } });
    const request = { operation: "prepare_git", workspace_id: workspace.id, action };
    createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!)({ request });
    const result = await invoke(request, "publish");
    expect(result).toMatchObject({ status: "succeeded", result: "Published", action_id: "publication" });
    expect(result.approval_url).toBeUndefined();
    expect(publishGit).toHaveBeenCalledExactlyOnceWith(workspace.id, owner, action, undefined);
    expect(requestGit).not.toHaveBeenCalled();
    await expect(makeTool("demo", "foreign@example.com")({ request }, "foreign")).rejects.toMatchObject({ status: 404 });
    expect(publishGit).toHaveBeenCalledTimes(1);
  });
  it("exposes current deployment choices without creating a workspace", async () => {
    const tool = createWorkspaceTool({ useCases, authorize, sleep, requestGit, publishGit, attachRepository, pullRequest,
      workdir: WORKSPACE_DIRECTORY, policy: () => ({ ...policy, deploymentWorkflows: ["deploy.yml"] }) },
    { agentName: "demo", ownerEmail: owner, occurrence: "options" });
    expect(JSON.parse((await tool({ request: { operation: "options" } }, "options")).text).deployment_workflows).toEqual(["deploy.yml"]);
    expect(await repository.list(owner, 20)).toHaveLength(0);
    expect(requestGit).not.toHaveBeenCalled();
  });
  it("rejects ambiguous deployment inputs and preserves approval-policy failures", async () => {
    const workspace = await useCases.create({ agentName: "demo", chatId: "deploy-chat", createChat: true,
      title: "Deploy", runtime: "codex", repository: "org/repo", baseBranch: "main" }, owner);
    const action = { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: [] };
    const request = { operation: "prepare_git", workspace_id: workspace.id, action };
    const validate = createToolSchemaValidator().compile(WORKSPACE_TOOL_DEF.function.parameters!);
    expect(() => validate({ request })).not.toThrow();
    expect(() => validate({ request: { ...request, action: { ...action, ref: "feature" } } })).toThrow();
    for (const inputs of [{}, [{ name: "target", value: 1 }], [{ name: "target", value: "a" }, { name: "target", value: "b" }]]) {
      await expect(invoke({ ...request, action: { ...action, inputs } })).rejects.toThrow();
    }
    expect(requestGit).not.toHaveBeenCalled();
    requestGit.mockRejectedValueOnce(new Error("Deployment must use an allowed workflow on main"));
    await expect(invoke(request)).rejects.toThrow("allowed workflow");
    expect(requestGit).toHaveBeenCalledExactlyOnceWith(workspace.id, owner,
      { kind: "deploy", workflow: "deploy.yml", ref: "main", inputs: {} }, undefined);
    expect(await repository.runs(workspace.id, 10)).toHaveLength(0);
  });
  it("reports PR publication and refreshes its current head/CI even without a native run", async () => {
    const workspace = await useCases.create({ agentName: "demo", chatId: "pr-chat", createChat: true,
      title: "PR", runtime: "codex", repository: "org/repo", baseBranch: "main" }, owner);
    const pr: PullRequestInfo = { number: 7, url: "https://example.test/org/repo/pull/7", headSha: "a".repeat(40), baseBranch: "main", draft: false, state: "open", ci: "pending" };
    await repository.write({ expectedRevision: workspace.revision, workspace: { ...workspace, pullRequest: pr, revision: workspace.revision + 1 } });
    pullRequest.mockResolvedValueOnce({ ...pr, ci: "none" });
    const result = await invoke({ operation: "status", workspace_id: workspace.id });
    expect(result.pull_request).toMatchObject({ number: 7, headSha: pr.headSha, ci: "none" });
    expect(pullRequest).toHaveBeenCalledExactlyOnceWith(workspace.id, owner);
    expect(await repository.runs(workspace.id, 10)).toHaveLength(0);
  });
  it("executes through the SDK tool dispatcher with the SDK call identity", async () => {
    const channel = new FakeChannel([[toolCallChunk(0, "workspace-call", "Workspace", JSON.stringify({ request: { operation: "options" } }))], [contentChunk("Ready")]]);
    const workspaceTool = vi.fn(makeTool());
    const chunks = [];
    for await (const chunk of runAgent({ channel, createToolSchemaValidator, workspaceTool }, { agentName: "demo", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Show Workspace options" }] })) chunks.push(chunk);
    expect(workspaceTool).toHaveBeenCalledWith({ request: { operation: "options" } }, "workspace-call");
    expect(chunks.some(chunk => chunk.toolResult?.name === "Workspace")).toBe(true);
  });
});
