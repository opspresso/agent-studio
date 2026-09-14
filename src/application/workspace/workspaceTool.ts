import { createHash } from "node:crypto";
import type { McpToolResult } from "@/domain/llm/types";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { workspaceRepositories, workspaceAllowsRepository } from "@/domain/workspace/policy";
import type { WorkspaceRuntime, WorkspaceInput } from "@/domain/workspace/types";
import { WORKSPACE_RUNTIMES, isTerminalWorkspaceRun } from "@/domain/workspace/types";
import { NotFoundError, ValidationError } from "@/application/errors";
import type { createWorkspaceUseCases } from "./workspaceUseCases";
import { boundedWorkspaceText } from "./output";

interface WorkspaceToolDeps {
  useCases: ReturnType<typeof createWorkspaceUseCases>;
  policy(): WorkspaceProjectPolicy | undefined;
  authorize(): Promise<void>;
  sleep(ms: number): Promise<void>;
}
interface WorkspaceToolContext { projectName: string; ownerEmail: string; occurrence: string }
const WAIT_STEPS = 8;
const OUTPUT_BYTES = 12_000;

/** The model can manage owned compute, but never consume Git/deployment approvals. */
export function createWorkspaceTool(deps: WorkspaceToolDeps, context: WorkspaceToolContext) {
  const input = (runtime: WorkspaceRuntime, task: string): WorkspaceInput => runtime === "command"
    ? { kind: "command", script: task } : { kind: "task", prompt: task };
  const reply = (value: unknown): McpToolResult => ({ text: JSON.stringify(value) });
  async function owned(id: string) {
    const detail = await deps.useCases.get(id, context.ownerEmail, true);
    if (detail.workspace.projectName !== context.projectName) throw new NotFoundError("Workspace not found");
    return detail;
  }
  return async (args: Record<string, unknown>, callId: string): Promise<McpToolResult> => {
    await deps.authorize();
    const policy = deps.policy();
    if (!policy) throw new ValidationError("Workspace tools are not enabled for this project");
    const request = args.request as Record<string, unknown>;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new ValidationError("Workspace requires a request");
    const operation = request.operation;
    if (operation === "options") return reply({ project: context.projectName, runtimes: policy.runtimes,
      repository: policy.repository ?? null, repositories: workspaceRepositories(policy), checks: policy.checks, git_actions: "Use the returned workspace_path to review and approve Git or deployment actions." });
    if (operation === "start" || operation === "run") {
      if (!callId || typeof request.task !== "string") throw new ValidationError("Workspace task identity is missing");
      const key = createHash("sha256").update(JSON.stringify([context.occurrence, context.projectName, callId])).digest("hex");
      if (operation === "start") {
        const runtime = request.runtime as WorkspaceRuntime;
        if (!WORKSPACE_RUNTIMES.includes(runtime)) throw new ValidationError("Invalid Workspace runtime");
        if ((request.repository !== null && typeof request.repository !== "string") ||
          (request.base_branch !== null && typeof request.base_branch !== "string")) throw new ValidationError("Invalid repository selection");
        if (request.repository !== null && !workspaceAllowsRepository(policy, request.repository as string)) throw new ValidationError("The requested repository is not configured for this project");
        if ((request.repository === null) !== (request.base_branch === null)) throw new ValidationError("Repository work requires both repository and base_branch");
        const started = await deps.useCases.start({ projectName: context.projectName, runtime,
          ...(request.repository !== null ? { repository: String(request.repository), baseBranch: String(request.base_branch) } : {}), input: input(runtime, request.task) }, context.ownerEmail, key);
        return reply({ workspace_id: started.workspace.id, run_id: started.run.id, status: started.run.status,
          workspace_path: `/chats/${started.workspace.chatId}`, next: "wait", after_seq: 0 });
      }
      const detail = await owned(String(request.workspace_id));
      const run = await deps.useCases.enqueue(detail.workspace.id, context.ownerEmail, input(detail.workspace.runtime, request.task), key);
      return reply({ workspace_id: detail.workspace.id, run_id: run.id, status: run.status,
        workspace_path: `/chats/${detail.workspace.chatId}`, next: "wait", after_seq: 0 });
    }
    const id = String(request.workspace_id);
    let detail = await owned(id);
    if (operation === "cancel" || operation === "close") {
      if (operation === "cancel") await deps.useCases.cancel(id, context.ownerEmail);
      else await deps.useCases.close(id, context.ownerEmail);
      return reply({ workspace_id: id, requested: operation, workspace_path: `/chats/${detail.workspace.chatId}` });
    }
    if (operation !== "status" && operation !== "wait") throw new ValidationError("Unknown Workspace operation");
    const after = request.after_seq ?? 0;
    if (!Number.isSafeInteger(after) || Number(after) < 0) throw new ValidationError("Invalid Workspace cursor");
    const runId = request.run_id === null ? detail.runs[0]?.id : String(request.run_id);
    if (!runId) return reply({ workspace_id: id, status: detail.workspace.status });
    // An explicit old run remains readable without accepting a foreign run id.
    if (!detail.runs.some(run => run.id === runId)) detail = await deps.useCases.get(id, context.ownerEmail);
    let run = detail.runs.find(run => run.id === runId);
    if (!run) throw new NotFoundError("Workspace run not found");
    if (operation === "wait") for (let step = 0; step < WAIT_STEPS && !isTerminalWorkspaceRun(run.status); step++) {
      await deps.sleep(1000);
      detail = await owned(id);
      run = detail.runs.find(current => current.id === runId) ?? run;
    }
    const events = await deps.useCases.events(id, context.ownerEmail, runId, Number(after));
    const selected = events.slice(0, 20);
    const raw = selected.flatMap(event => event.data.kind === "output" || event.data.kind === "message" || event.data.kind === "warning" ? [event.data.text] : []).join("");
    const output = boundedWorkspaceText(raw, OUTPUT_BYTES);
    const diff = boundedWorkspaceText(run.diff ?? "", OUTPUT_BYTES);
    return reply({ workspace_id: id, workspace_status: detail.workspace.status, workspace_path: `/chats/${detail.workspace.chatId}`,
      run_id: run.id, status: run.status, error: run.error, runtime: detail.workspace.runtime,
      repository: detail.workspace.coding?.repository, branch: detail.workspace.coding?.branch,
      checks: run.checks.map(({ output: _output, ...check }) => { void _output; return check; }),
      output: output.text, diff: diff.text, truncated: output.truncated || diff.truncated || !!run.diffTruncated,
      next_seq: selected.at(-1)?.seq ?? after, has_more: events.length > selected.length || (selected.at(-1)?.seq ?? Number(after)) < run.lastEventSeq,
      next: isTerminalWorkspaceRun(run.status) ? "review results" : "wait" });
  };
}
