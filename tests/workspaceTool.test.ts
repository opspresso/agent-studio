import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "./fakeStore";
import * as store from "@/infrastructure/db/store";
import { keys } from "@/infrastructure/db/keys";
import { workspaceRepository as repository } from "@/infrastructure/db/repositories/workspaceRepository";
import { chatRepository as chats } from "@/infrastructure/db/repositories/chatRepository";
import { projectRepository as projects } from "@/infrastructure/db/repositories/projectRepository";
import { createWorkspaceUseCases, type WorkspaceView } from "@/application/workspace/workspaceUseCases";
import { WORKSPACE_DIRECTORY } from "@/infrastructure/workspace/runtimeAdapters";
import { createWorkspaceTool } from "@/application/workspace/workspaceTool";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { WORKSPACE_TOOL_DEF } from "@/application/llm/workspaceToolDefinition";
import { assembleAgentRun } from "@/application/llm/agentAssembly";
import { runAgent } from "@/application/runtime";
import { FakeChannel, contentChunk, toolCallChunk } from "./fakeChannel";
import type { CodingApproval } from "@/domain/coding/types";

vi.mock("@/infrastructure/db/store", () => createFakeStore());
const fake = store as unknown as ReturnType<typeof createFakeStore>;
const now = new Date("2026-09-14T00:00:00Z");
const owner = "owner@example.com";
let serial = 0;
const policy = { projectName: "demo", runtimes: ["command", "codex"] as ("command" | "codex")[], repository: "org/repo", checks: [], deploymentWorkflows: [] };
const useCases = createWorkspaceUseCases({ repository, chats, projects, now: () => now, newId: () => `id-${++serial}`,
  policy: () => policy, idleTtlSeconds: 60 });
const authorize = vi.fn(async () => {});
const sleep = vi.fn(async (_ms: number) => {});
const requestGit = vi.fn<(...args: unknown[]) => Promise<CodingApproval>>();
const attachRepository = vi.fn<(...args: unknown[]) => Promise<WorkspaceView>>();
const makeTool = (projectName = "demo", ownerEmail = owner, sourceChatId?: string, occurrence = "parent-run") => createWorkspaceTool({ useCases, authorize, sleep, requestGit, attachRepository, workdir: WORKSPACE_DIRECTORY, policy: () => policy }, { projectName, ownerEmail, sourceChatId, occurrence });
const invoke = async (request: Record<string, unknown>, callId = "call-start") => JSON.parse((await makeTool()({ request }, callId)).text);
const start = { operation: "start", runtime: "command", repository: null, base_branch: null, task: "printf report > report.txt" };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); serial = 0; fake.rows.clear();
  fake.seed([{ ...keys.project("demo"), entityType: "PROJECT", name: "demo", displayName: "Demo", description: "", ownerEmail: owner, projectType: "agent", visibility: "public", createdAt: now.toISOString(), updatedAt: now.toISOString() }]);
});
afterEach(() => vi.useRealTimers());

describe("Workspace Agent capability", () => {
  it("reuses the source chat across tool IDs and turns, then accepts a minimal follow-up run", async () => {
    await chats.create({ chatId: "source-chat", projectName: "demo", title: "Task", ownerEmail: owner, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    const tool = makeTool("demo", owner, "source-chat");
    const first = JSON.parse((await tool({ request: start }, "start-1")).text);
    expect(first.workdir).toBe(WORKSPACE_DIRECTORY);
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
    expect(options.default_repository).toBe("org/repo");
  });

  it("requires explicit selection before mutating a different Workspace", async () => {
    await chats.create({ chatId: "source-chat", projectName: "demo", title: "Task", ownerEmail: owner, createdAt: now.toISOString(), updatedAt: now.toISOString() });
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
    const disabled = createWorkspaceTool({ useCases, authorize, sleep, requestGit, attachRepository, workdir: WORKSPACE_DIRECTORY, policy: () => undefined }, { projectName: "demo", ownerEmail: owner, occurrence: "parent" });
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
  it("rejects an unconfigured repository and foreign owners or projects", async () => {
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
  it("prepares an owned Git review and reuses a pending review without executing native tasks", async () => {
    const workspace = await useCases.create({ projectName: "demo", chatId: "review-chat", createChat: true,
      title: "Review", runtime: "codex", repository: "org/repo", baseBranch: "main" }, owner);
    const action = { kind: "commit-and-push" as const, message: "feat: change" };
    const approval: CodingApproval = { id: "approval-1", workspaceId: workspace.id, action, requestedBy: owner,
      requestedAt: now.toISOString(), status: "pending", fingerprint: "reviewed-tree",
      review: { headSha: "a".repeat(40), treeSha: "b".repeat(40), diff: "+change", truncated: false } };
    requestGit.mockImplementationOnce(async () => {
      await repository.write({ expectedRevision: workspace.revision,
        workspace: { ...workspace, activeActionId: approval.id, revision: workspace.revision + 1 } });
      await repository.write({ expectedRevision: workspace.revision + 1,
        workspace: { ...workspace, activeActionId: approval.id, revision: workspace.revision + 2 }, approval });
      return approval;
    });
    const request = { operation: "prepare_git", workspace_id: workspace.id, action };
    const result = await invoke(request, "git-call");
    expect(result).toMatchObject({ status: "pending", approval_id: approval.id, approval_path: "/chats/review-chat#actions" });
    expect(await invoke(request, "git-call")).toEqual(result);
    expect(requestGit).toHaveBeenCalledExactlyOnceWith(workspace.id, owner, action);
    expect(await repository.runs(workspace.id, 10)).toHaveLength(0);
    await expect(makeTool("foreign")({ request }, "git-call")).rejects.toMatchObject({ status: 404 });
    await expect(makeTool("demo", "foreign@example.com")({ request }, "git-call")).rejects.toMatchObject({ status: 404 });
    expect(requestGit).toHaveBeenCalledTimes(1);
  });
  it("executes through the SDK tool dispatcher with the SDK call identity", async () => {
    const channel = new FakeChannel([[toolCallChunk(0, "workspace-call", "Workspace", JSON.stringify({ request: { operation: "options" } }))], [contentChunk("Ready")]]);
    const workspaceTool = vi.fn(makeTool());
    const chunks = [];
    for await (const chunk of runAgent({ channel, createToolSchemaValidator, workspaceTool }, { projectName: "demo", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "Show Workspace options" }] })) chunks.push(chunk);
    expect(workspaceTool).toHaveBeenCalledWith({ request: { operation: "options" } }, "workspace-call");
    expect(chunks.some(chunk => chunk.toolResult?.name === "Workspace")).toBe(true);
  });
});
