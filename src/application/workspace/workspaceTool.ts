import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { McpToolResult } from "@/domain/llm/types";
import type { WorkspaceProjectPolicy } from "@/domain/workspace/policy";
import { isRepositoryName, workspaceRepositories, workspaceAllowsRepository, workspaceAllowsRepositoryCreation, workspaceRepositoryMode } from "@/domain/workspace/policy";
import type { createWorkspaceRepositoryCreationUseCases } from "./createRepository";
import type { WorkspaceRuntime, WorkspaceInput } from "@/domain/workspace/types";
import { WORKSPACE_RUNTIMES, isTerminalWorkspaceRun } from "@/domain/workspace/types";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import type { createWorkspaceUseCases, WorkspaceView } from "./workspaceUseCases";
import type { CodingApproval, CodingAction, PullRequestInfo } from "@/domain/coding/types";
import { boundedWorkspaceText } from "./output";

interface WorkspaceToolDeps {
  useCases: ReturnType<typeof createWorkspaceUseCases>;
  createRepository?: ReturnType<typeof createWorkspaceRepositoryCreationUseCases>["create"];
  policy(): WorkspaceProjectPolicy | undefined | Promise<WorkspaceProjectPolicy | undefined>;
  authorize(): Promise<void>;
  sleep(ms: number): Promise<void>;
  requestGit(id: string, ownerEmail: string, action: CodingAction, sourceChatId?: string): Promise<CodingApproval>;
  pullRequest(id: string, ownerEmail: string): Promise<PullRequestInfo | undefined>;
  attachRepository(id: string, ownerEmail: string, repository: string, baseBranch: string): Promise<WorkspaceView>;
  workdir: string;
  publicBaseUrl?: string;
}
interface WorkspaceToolContext { projectName: string; ownerEmail: string; occurrence: string; sourceChatId?: string }
const WAIT_STEPS = 8;
const OUTPUT_BYTES = 12_000;

/** The model can manage owned compute, but never consume Git/deployment approvals. */
export function createWorkspaceTool(deps: WorkspaceToolDeps, context: WorkspaceToolContext) {
  const startKey = createHash("sha256").update(JSON.stringify([context.occurrence, context.projectName, "workspace-start"])).digest("hex");
  const input = (runtime: WorkspaceRuntime, task: string): WorkspaceInput => runtime === "command"
    ? { kind: "command", script: task } : { kind: "task", prompt: task };
  const reply = (value: unknown, failed = false): McpToolResult => ({ text: `${failed ? "Error: " : ""}${JSON.stringify(value)}` });
  const url = (path: string) => deps.publicBaseUrl ? new URL(path, deps.publicBaseUrl).href : path;
  const repositoryPolicyUrl = url(`/agents/${encodeURIComponent(context.projectName)}/workspace`);
  const location = (workspace: WorkspaceView) => ({ workspace_id: workspace.id, workspace_path: `/chats/${workspace.chatId}`,
    workspace_url: url(`/chats/${workspace.chatId}`),
    workdir: deps.workdir, runtime: workspace.runtime, repository: workspace.coding?.repository ?? null,
    base_branch: workspace.coding?.baseBranch ?? null, branch: workspace.coding?.branch ?? null,
    head_sha: workspace.coding?.headSha ?? null, workspace_status: workspace.status, pull_request: workspace.pullRequest ?? null });
  const current = () => context.sourceChatId
    ? deps.useCases.forSourceChat(context.sourceChatId, context.projectName, context.ownerEmail)
    : deps.useCases.forStartRequest(context.projectName, context.ownerEmail, startKey);
  async function owned(id: string) {
    const detail = await deps.useCases.get(id, context.ownerEmail, true);
    if (detail.workspace.projectName !== context.projectName) throw new NotFoundError("Workspace not found");
    return detail;
  }
  async function resolve(request: Record<string, unknown>, mutate = false) {
    const selected = (!request.workspace_id || mutate) ? await current() : null;
    const id = typeof request.workspace_id === "string" ? request.workspace_id : selected?.id;
    if (!id) throw new ValidationError("No Workspace is selected. Read options and start a Workspace first");
    if (mutate && selected && selected.id !== id) throw new ConflictError(`This chat uses Workspace ${selected.id}. Use use_workspace to explicitly select another existing Workspace`);
    const detail = await owned(id);
    if (mutate && !selected && context.sourceChatId) await deps.useCases.selectForChat(context.sourceChatId, id, context.projectName, context.ownerEmail);
    return detail;
  }
  return async (args: Record<string, unknown>, callId: string): Promise<McpToolResult> => {
    await deps.authorize();
    const policy = await deps.policy();
    if (!policy) throw new ValidationError("Workspace tools are not enabled for this project");
    const request = args.request as Record<string, unknown>;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new ValidationError("Workspace requires a request");
    const operation = request.operation;
    if (operation === "options") {
      const selected = await current();
      return reply({ project: context.projectName, runtimes: policy.runtimes, workdir: deps.workdir,
      current_workspace: selected ? location(selected) : null,
      repository_mode: workspaceRepositoryMode(policy), can_create_repositories: !!deps.createRepository,
      default_runtime: policy.defaultRuntime ?? "command", repositories: workspaceRepositories(policy), repository_owners: policy.repositoryOwners ?? [],
      repository_policy_url: repositoryPolicyUrl, checks: policy.checks, deployment_workflows: policy.deploymentWorkflows,
      repository_setup: "Check repository access for the exact owner/name before creation. selected permits listed names; owners also permits listed owners; all permits any name the GitHub account can access; new permits listed names plus repositories created by this project's Workspace create_repository operation. In new mode, creation_allowed may be true while allowed is false. For a user-requested NEW repository use Workspace create_repository; it initializes a README and automatically registers a successful creation. Do not use an MCP create tool or claim an existing repository is new to obtain registration. Then check_repository with the returned base_branch before clone. If both access and creation are blocked, return repository_policy_url. Never create another name to bypass policy.",
      workspace_selection: "A chat keeps one selected Workspace per project. Repeated start returns it without queueing work. Use run for follow-ups. Both repository and base_branch must be selected for a clone; null means deliberately Git-free. workspace_path is a browser link; task files belong in workdir, using relative paths.",
      git_actions: "Use prepare_git for commit, commit-and-push, push (work branch), pull-request (title/body/draft), merge (pullRequestNumber/headSha from status.pull_request), push-main (already published work branch, fast-forward only), or deploy (workflow from deployment_workflows, ref main, inputs as name/value pairs). Deployment approval only dispatches the workflow; use its run and application health to verify completion. Return approval_url verbatim and pause this turn. When requested from a chat, the decision outcome returns there automatically and the agent resumes the remaining request. Read status and prepare the next requested action for its own review. Closed Workspaces resume for Git review; never close or create another Workspace to publish. Only the user's Workspace approval UI executes these actions. Native tasks cannot write /control/git; do not retry Git writes with a temporary index, changed permissions or GitHub tools." });
    }
    if (operation === "check_repository_access") {
      if (typeof request.repository !== "string" || !isRepositoryName(request.repository)) throw new ValidationError("Repository must use owner/repository");
      const allowed = workspaceAllowsRepository(policy, request.repository);
      const creationAllowed = !!deps.createRepository && workspaceAllowsRepositoryCreation(policy, request.repository);
      return reply({ repository: request.repository, allowed, creation_allowed: creationAllowed, repository_mode: workspaceRepositoryMode(policy), repository_policy_url: repositoryPolicyUrl,
        message: allowed ? "Workspace policy allows this name. GitHub existence, credentials and a first commit must still be checked before clone."
          : creationAllowed ? "An existing repository is not allowed, but you may create this name with Workspace create_repository when the user requested a new repository. Successful server creation is automatically registered."
          : "An administrator must allow this repository or its exact owner in the project's Workspace repository settings. No repository or Workspace was created." });
    }
    if (operation === "create_repository") {
      if (!deps.createRepository) throw new ValidationError("Workspace repository creation is not configured");
      if (typeof request.repository !== "string" || typeof request.description !== "string" || typeof request.private !== "boolean") throw new ValidationError("Repository, description and private are required");
      const outcome = await deps.createRepository(context.projectName, { repository: request.repository, description: request.description, private: request.private }, context.ownerEmail);
      return reply({ ...outcome, ...(outcome.result ? { repository_url: outcome.result.url, base_branch: outcome.result.baseBranch } : {}),
        repository_policy_url: repositoryPolicyUrl, workspace_created: false, task_queued: false,
        next: outcome.status === "created" && outcome.allowed ? "check_repository with base_branch, then start the requested work" : "inspect the reported outcome and policy; never repeat an uncertain creation" }, outcome.status !== "created" || !outcome.allowed);
    }
    if (operation === "use_workspace") {
      if (!context.sourceChatId) throw new ValidationError("Workspace selection requires a chat");
      const detail = await owned(String(request.workspace_id));
      const selected = await deps.useCases.selectForChat(context.sourceChatId, detail.workspace.id, context.projectName, context.ownerEmail);
      return reply({ ...location(selected), selected: true, task_queued: false, next: "run" });
    }
    if (operation === "check_repository") {
      if (typeof request.repository !== "string" || typeof request.base_branch !== "string") throw new ValidationError("Repository and base_branch are required");
      if (!workspaceAllowsRepository(policy, request.repository)) throw new ValidationError(`Repository is not allowed by Workspace policy. The project owner can update ${repositoryPolicyUrl}`);
      await deps.useCases.checkRepository(context.projectName, context.ownerEmail, request.repository, request.base_branch);
      return reply({ repository: request.repository, base_branch: request.base_branch, ready: true,
        message: "The Workspace GitHub account can read the base branch. No Workspace, repository or task was created." });
    }
    if (operation === "start" || operation === "run") {
      if (!callId || typeof request.task !== "string") throw new ValidationError("Workspace task identity is missing");
      const key = createHash("sha256").update(JSON.stringify([context.occurrence, context.projectName, callId])).digest("hex");
      if (operation === "start") {
        const runtime = (request.runtime ?? policy.defaultRuntime ?? "command") as WorkspaceRuntime;
        if (!WORKSPACE_RUNTIMES.includes(runtime)) throw new ValidationError("Invalid Workspace runtime");
        if ((request.repository !== null && typeof request.repository !== "string") ||
          (request.base_branch !== null && typeof request.base_branch !== "string")) throw new ValidationError("Invalid repository selection");
        if (request.repository !== null && !workspaceAllowsRepository(policy, request.repository as string)) throw new ValidationError(`Repository is not allowed by Workspace policy. The project owner can update ${repositoryPolicyUrl}`);
        if ((request.repository === null) !== (request.base_branch === null)) throw new ValidationError("Repository work requires both repository and base_branch");
        const startInput = { projectName: context.projectName, runtime,
          ...(request.repository !== null ? { repository: String(request.repository), baseBranch: String(request.base_branch) } : {}), input: input(runtime, request.task) };
        let started;
        if (context.sourceChatId) started = await deps.useCases.startForChat(startInput, context.ownerEmail, context.sourceChatId);
        else {
          try { started = { ...await deps.useCases.start(startInput, context.ownerEmail, startKey), reused: false }; }
          catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            const existing = await current();
            if (!existing) throw error;
            started = { workspace: existing, reused: true };
          }
        }
        if (started.reused) return reply({ ...location(started.workspace), reused: true, task_queued: false,
          run_id: started.workspace.activeRunId ?? null, workspace_status: started.workspace.status,
          next: started.workspace.activeRunId ? "wait" : "run", after_seq: 0,
          message: "This chat already has a Workspace. No new Workspace or task was created. Use run for follow-up work. To attach a repository to a Git-free Workspace, use attach_repository; do not call start again." });
        return reply({ ...location(started.workspace), run_id: started.run!.id, status: started.run!.status,
          reused: false, task_queued: true, next: "wait", after_seq: 0 });
      }
      const detail = await resolve(request, true);
      if ((request.runtime != null && request.runtime !== detail.workspace.runtime) ||
        (request.repository != null && String(request.repository).toLowerCase() !== detail.workspace.coding?.repository.toLowerCase()) ||
        (request.base_branch != null && request.base_branch !== detail.workspace.coding?.baseBranch)) {
        throw new ValidationError("run keeps the selected Workspace's runtime and repository. Read options; use attach_repository to connect a Git-free Workspace");
      }
      const run = await deps.useCases.enqueue(detail.workspace.id, context.ownerEmail, input(detail.workspace.runtime, request.task), key);
      return reply({ ...location(detail.workspace), run_id: run.id, status: run.status, next: "wait", after_seq: 0 });
    }
    if (!["status", "wait", "attach_repository", "prepare_git", "cancel", "close"].includes(String(operation))) throw new ValidationError("Unknown Workspace operation");
    let detail = await resolve(request, !["status", "wait"].includes(String(operation)));
    const id = detail.workspace.id;
    if (operation === "attach_repository") {
      if (typeof request.repository !== "string" || typeof request.base_branch !== "string") throw new ValidationError("Repository and base_branch are required");
      if (!workspaceAllowsRepository(policy, request.repository)) throw new ValidationError(`Repository is not allowed by Workspace policy. The project owner can update ${repositoryPolicyUrl}`);
      const workspace = await deps.attachRepository(id, context.ownerEmail, request.repository, request.base_branch);
      return reply({ ...location(workspace), task_queued: false, next: "run" });
    }
    if (operation === "prepare_git") {
      if (!detail.workspace.coding) throw new ValidationError("This workspace has no Git repository");
      const value = request.action as Record<string, unknown> | undefined;
      if (!value) throw new ValidationError("Invalid Workspace Git action");
      let action: CodingAction;
      if (value.kind === "push" || value.kind === "push-main") action = { kind: value.kind };
      else if (value.kind === "pull-request") {
        if (typeof value.title !== "string" || typeof value.body !== "string" || typeof value.draft !== "boolean") throw new ValidationError("Pull request title, body and draft are required");
        action = { kind: "pull-request", title: value.title, body: value.body, draft: value.draft };
      } else if (value.kind === "merge") {
        if (!Number.isSafeInteger(value.pullRequestNumber) || Number(value.pullRequestNumber) < 1 || typeof value.headSha !== "string" || !/^[a-f0-9]{40,64}$/.test(value.headSha)) throw new ValidationError("The pull request number and exact head SHA are required; read status.pull_request");
        action = { kind: "merge", pullRequestNumber: Number(value.pullRequestNumber), headSha: value.headSha };
      } else if (value.kind === "commit" || value.kind === "commit-and-push") {
        if (typeof value.message !== "string") throw new ValidationError("A commit message is required");
        action = { kind: value.kind, message: value.message };
      } else if (value.kind === "deploy") {
        if (typeof value.workflow !== "string" || value.ref !== "main" || !Array.isArray(value.inputs)) {
          throw new ValidationError("Deployment requires a workflow, ref main and an inputs array");
        }
        const entries: [string, string][] = [];
        for (const entry of value.inputs) {
          if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.value !== "string" ||
            entries.some(([name]) => name === entry.name)) throw new ValidationError("Deployment input names must be unique with string values");
          entries.push([entry.name, entry.value]);
        }
        action = { kind: "deploy", workflow: value.workflow, ref: value.ref, inputs: Object.fromEntries(entries) };
      } else throw new ValidationError("Unsupported Git action. Use commit, commit-and-push, push, pull-request, merge, push-main or deploy; do not use a native task or another Workspace");
      const pending = detail.approvals.find(item => item.id === detail.workspace.activeActionId && item.status === "pending");
      const same = pending && isDeepStrictEqual(pending.action, action);
      const approval = same && pending && pending.sourceChatId === context.sourceChatId ? pending
        : await deps.requestGit(id, context.ownerEmail, action, context.sourceChatId);
      return reply({ ...location(detail.workspace),
        approval_path: `/chats/${detail.workspace.chatId}#actions`, approval_id: approval.id,
        approval_url: url(`/chats/${detail.workspace.chatId}#actions`),
        ...(approval.sourceChatId ? { source_chat_url: url(`/chats/${approval.sourceChatId}`) } : {}),
        action: approval.action, status: approval.status, next: approval.sourceChatId
          ? "Return approval_url and pause this turn. After the decision, the result is delivered to this chat and the agent resumes the remaining user request automatically. A resumed PR result with ci_watch also resumes when that head's checks finish (up to 30 minutes); do not poll repeatedly or ask the user to repeat the request. This approves only this action; prepare any later Git action for its own review. Never replay a succeeded or uncertain action."
          : "Return approval_url and pause. This request has no source chat; the caller must check status after approval." });
    }
    if (operation === "cancel" || operation === "close") {
      if (operation === "cancel") await deps.useCases.cancel(id, context.ownerEmail);
      else await deps.useCases.close(id, context.ownerEmail);
      return reply({ ...location(detail.workspace), requested: operation });
    }
    if (operation !== "status" && operation !== "wait") throw new ValidationError("Unknown Workspace operation");
    const git = { git_action: detail.approvals[0] ? { id: detail.approvals[0].id, action: detail.approvals[0].action,
      status: detail.approvals[0].status, result: detail.approvals[0].result } : null,
      pull_request: operation === "status" && detail.workspace.pullRequest
        ? await deps.pullRequest(id, context.ownerEmail) : detail.workspace.pullRequest ?? null };
    const after = request.after_seq ?? 0;
    if (!Number.isSafeInteger(after) || Number(after) < 0) throw new ValidationError("Invalid Workspace cursor");
    const runId = request.run_id == null ? detail.runs[0]?.id : String(request.run_id);
    if (!runId) return reply({ ...location(detail.workspace), ...git, status: detail.workspace.status, next: "run or prepare_git" });
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
    const raw = selected.flatMap(event => event.data.kind === "output" ? [event.data.text] : event.data.kind === "message" || event.data.kind === "warning" ? [`\n${event.data.text}\n`] : []).join("");
    const output = boundedWorkspaceText(raw, OUTPUT_BYTES);
    const diff = boundedWorkspaceText(run.diff ?? "", OUTPUT_BYTES);
    return reply({ ...location(detail.workspace), workspace_status: detail.workspace.status,
      run_id: run.id, status: run.status, error: run.error,
      ...git,
      checks: run.checks.map(({ output: _output, ...check }) => { void _output; return check; }),
      output: output.text, diff: diff.text, truncated: output.truncated || diff.truncated || !!run.diffTruncated,
      next_seq: selected.at(-1)?.seq ?? after, has_more: events.length > selected.length || (selected.at(-1)?.seq ?? Number(after)) < run.lastEventSeq,
      next: isTerminalWorkspaceRun(run.status) ? "review results" : "wait" });
  };
}
