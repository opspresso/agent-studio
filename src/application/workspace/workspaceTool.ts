import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { McpToolResult } from "@/domain/llm/types";
import type { WorkspaceAgentPolicy } from "@/domain/workspace/policy";
import { isGitBranch, isRepositoryName, workspaceRepositories, workspaceAllowsRepository, workspaceAllowsRepositoryCreation, workspaceRepositoryMode } from "@/domain/workspace/policy";
import type { createWorkspaceRepositoryCreationUseCases } from "./createRepository";
import type { WorkspaceRuntime, WorkspaceInput } from "@/domain/workspace/types";
import type { RunIdentity, RunUser } from "@/domain/execution/actor";
import { WORKSPACE_RUNTIMES, isTerminalWorkspaceRun } from "@/domain/workspace/types";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import type { createWorkspaceUseCases, WorkspaceView } from "./workspaceUseCases";
import type { CodingApproval, CodingAction, PullRequestInfo } from "@/domain/coding/types";
import { codingActionRequiresConfirmation } from "@/domain/coding/types";
import { boundedWorkspaceText } from "./output";
import type { PullRequestReviewTarget } from "@/domain/trigger/pullRequestReview";

interface WorkspaceToolDeps {
  useCases: ReturnType<typeof createWorkspaceUseCases>;
  createRepository?: ReturnType<typeof createWorkspaceRepositoryCreationUseCases>["create"];
  policy(): WorkspaceAgentPolicy | undefined | Promise<WorkspaceAgentPolicy | undefined>;
  authorize(): Promise<void>;
  sleep(ms: number): Promise<void>;
  requestGit(id: string, identity: RunIdentity, action: CodingAction, sourceChatId?: string): Promise<CodingApproval>;
  publishGit(id: string, identity: RunIdentity, action: CodingAction, sourceChatId?: string): Promise<CodingApproval>;
  pullRequest(id: string, user: RunUser): Promise<PullRequestInfo | undefined>;
  attachRepository(id: string, user: RunUser, repository: string, baseBranch: string): Promise<WorkspaceView>;
  workdir: string;
  publicBaseUrl?: string;
}
interface WorkspaceToolContext extends RunIdentity { agentName: string; ownerEmail: string; occurrence: string; sourceChatId?: string; reviewTarget?: PullRequestReviewTarget }
const WAIT_STEPS = 8;
const OUTPUT_BYTES = 12_000;

/** Work-branch publication is included in coding; protected actions retain confirmation. */
export function createWorkspaceTool(deps: WorkspaceToolDeps, context: WorkspaceToolContext) {
  const startKey = createHash("sha256").update(JSON.stringify([context.occurrence, context.agentName, "workspace-start"])).digest("hex");
  const input = (runtime: WorkspaceRuntime, task: string): WorkspaceInput => runtime === "command"
    ? { kind: "command", script: task } : { kind: "task", prompt: task };
  const reply = (value: unknown, failed = false): McpToolResult => ({ text: `${failed ? "Error: " : ""}${JSON.stringify(value)}` });
  const url = (path: string) => deps.publicBaseUrl ? new URL(path, deps.publicBaseUrl).href : path;
  const repositoryPolicyUrl = url(`/agents/${encodeURIComponent(context.agentName)}/workspace`);
  let selectedWorkspaceId: string | undefined;
  const location = (workspace: WorkspaceView) => ({ workspace_id: workspace.id, title: workspace.title, workspace_path: `/chats/${workspace.chatId}`,
    workspace_url: url(`/chats/${workspace.chatId}`),
    workdir: deps.workdir, runtime: workspace.runtime, repository: workspace.coding?.repository ?? null,
    base_branch: workspace.coding?.baseBranch ?? null, branch: workspace.coding?.branch ?? null,
    head_sha: workspace.coding?.headSha ?? null, workspace_status: workspace.status, pull_request: workspace.pullRequest ?? null });
  const current = async () => context.sourceChatId
    ? deps.useCases.forSourceChat(context.sourceChatId, context.agentName, context.ownerEmail)
    : selectedWorkspaceId ? (await owned(selectedWorkspaceId)).workspace
      : deps.useCases.forStartRequest(context.agentName, context.ownerEmail, startKey);
  async function owned(id: string) {
    if (context.reviewTarget && id !== (await deps.useCases.forStartRequest(context.agentName, context.ownerEmail, startKey))?.id) throw new NotFoundError("Review Workspace not found");
    const detail = await deps.useCases.get(id, context.ownerEmail, true);
    if (detail.workspace.agentName !== context.agentName) throw new NotFoundError("Workspace not found");
    return detail;
  }
  async function resolve(request: Record<string, unknown>, mutate = false) {
    const selected = (!request.workspace_id || mutate) ? await current() : null;
    const id = typeof request.workspace_id === "string" ? request.workspace_id : selected?.id;
    if (!id) throw new ValidationError("No Workspace is selected. Read options and start a Workspace first");
    if (mutate && selected && selected.id !== id) throw new ConflictError(`This request uses Workspace ${selected.id}. Use use_workspace to explicitly select another existing Workspace`);
    const detail = await owned(id);
    if (mutate && !selected && context.sourceChatId) await deps.useCases.selectForChat(context.sourceChatId, id, context.agentName, context.ownerEmail);
    return detail;
  }
  return async (args: Record<string, unknown>, callId: string): Promise<McpToolResult> => {
    if (!context.user.userId || context.user.email !== context.ownerEmail) throw new ValidationError("Workspace requires an authenticated Studio user");
    await deps.authorize();
    const policy = await deps.policy();
    if (!policy) throw new ValidationError("Workspace tools are not enabled for this agent");
    let request = args.request as Record<string, unknown>;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new ValidationError("Workspace requires a request");
    const operation = request.operation;
    if (context.reviewTarget) {
      if (!["options", "start", "run", "status", "wait"].includes(String(operation))) throw new ValidationError("Review Workspace supports only source reads and isolated checks; lifecycle and publication belong to the platform");
      const target = context.reviewTarget;
      const baseBranch = `review/${target.headSha}`;
      if ((request.repository != null && request.repository !== target.repository) ||
        (request.base_branch != null && request.base_branch !== baseBranch) ||
        (request.runtime != null && request.runtime !== "command")) throw new ValidationError("Review Workspace is fixed to the verified PR repository, commit and command runtime");
      if (operation === "start") request = { ...request, repository: target.repository, base_branch: baseBranch, runtime: "command", title: `PR #${target.number} review` };
      if (operation === "options") {
        const selected = await current();
        return reply({ agent: context.agentName, runtimes: ["command"], default_runtime: "command", workdir: deps.workdir,
        current_workspace: selected ? location(selected) : null, repository: target.repository, head_sha: target.headSha,
        base_branch: baseBranch, operations: ["options", "run", "status", "wait"], message: "Read files and run isolated checks at this verified commit. The platform closes the Workspace after posting the review. Git publication and other Workspaces are unavailable." });
      }
    }
    if (operation === "options") {
      const selected = await current();
      return reply({ agent: context.agentName, runtimes: policy.runtimes, workdir: deps.workdir,
      current_workspace: selected ? location(selected) : null,
      repository_mode: workspaceRepositoryMode(policy), can_create_repositories: !!deps.createRepository,
      default_runtime: policy.defaultRuntime ?? "command", repositories: workspaceRepositories(policy), repository_owners: policy.repositoryOwners ?? [],
      repository_policy_url: repositoryPolicyUrl, checks: policy.checks, deployment_workflows: policy.deploymentWorkflows,
      repository_setup: "Check repository access for the exact owner/name before creation. selected permits listed names; owners also permits listed owners; all permits any name this Agent's GitHub MCP account can access; new permits listed names plus repositories created by this agent's Workspace create_repository operation. In new mode, creation_allowed may be true while allowed is false. For a user-requested NEW repository use Workspace create_repository; it initializes a README and automatically registers a successful creation. Do not use an MCP create tool or claim an existing repository is new to obtain registration. Then check_repository with the returned base_branch before clone. If both access and creation are blocked, return repository_policy_url. Never create another name to bypass policy.",
      workspace_selection: "A chat keeps one selected Workspace per agent. Outside a chat, use_workspace selects an owned Workspace for this Agent run; select it again on a later request. Repeated start returns the selected Workspace without queueing work. Use run for follow-ups. Both repository and base_branch must be selected for a clone; null means deliberately Git-free. workspace_path is a browser link; task files belong in workdir, using relative paths.",
      git_actions: "A coding request includes implementation, checks, commit, push to the Workspace branch and a pull request unless the user limits the scope. Use prepare_git for every Git action. commit, commit-and-push, push and pull-request execute immediately and return actual results; continue until the PR exists without asking for another approval. merge, push-main, tag, release and deploy require a separate user request and confirmation: return approval_url and pause only for pending actions. Use merge with pullRequestNumber/headSha from status.pull_request; push-main requires a published branch and fast-forward. tag creates a named tag on the reviewed current main commit. release publishes an existing tag with title/body/draft/prerelease. Never overwrite tags. Deployment uses a configured workflow, ref main and inputs as name/value pairs; verify the workflow and service afterward. Closed Workspaces resume for Git actions. Native tasks cannot write /control/git; never bypass this with GitHub tools or credentials." });
    }
    if (operation === "check_repository_access") {
      if (typeof request.repository !== "string" || !isRepositoryName(request.repository)) throw new ValidationError("Repository must use owner/repository");
      const allowed = workspaceAllowsRepository(policy, request.repository);
      const creationAllowed = !!deps.createRepository && workspaceAllowsRepositoryCreation(policy, request.repository);
      return reply({ repository: request.repository, allowed, creation_allowed: creationAllowed, repository_mode: workspaceRepositoryMode(policy), repository_policy_url: repositoryPolicyUrl,
        message: allowed ? "Workspace policy allows this name. GitHub existence, credentials and a first commit must still be checked before clone."
          : creationAllowed ? "An existing repository is not allowed, but you may create this name with Workspace create_repository when the user requested a new repository. Successful server creation is automatically registered."
          : "An administrator must allow this repository or its exact owner in the agent's Workspace repository settings. No repository or Workspace was created." });
    }
    if (operation === "create_repository") {
      if (!deps.createRepository) throw new ValidationError("Workspace repository creation is not configured");
      if (typeof request.repository !== "string" || typeof request.description !== "string" || typeof request.private !== "boolean") throw new ValidationError("Repository, description and private are required");
      const outcome = await deps.createRepository(context.agentName, { repository: request.repository, description: request.description, private: request.private }, context.user);
      return reply({ ...outcome, ...(outcome.result ? { repository_url: outcome.result.url, base_branch: outcome.result.baseBranch } : {}),
        repository_policy_url: repositoryPolicyUrl, workspace_created: false, task_queued: false,
        next: outcome.status === "created" && outcome.allowed ? "check_repository with base_branch, then start the requested work" : "inspect the reported outcome and policy; never repeat an uncertain creation" }, outcome.status !== "created" || !outcome.allowed);
    }
    if (operation === "use_workspace") {
      const detail = await owned(String(request.workspace_id));
      const selected = context.sourceChatId
        ? await deps.useCases.selectForChat(context.sourceChatId, detail.workspace.id, context.agentName, context.ownerEmail)
        : detail.workspace;
      if (!context.sourceChatId) selectedWorkspaceId = selected.id;
      return reply({ ...location(selected), selected: true, task_queued: false, next: "run" });
    }
    if (operation === "check_repository") {
      if (typeof request.repository !== "string" || typeof request.base_branch !== "string") throw new ValidationError("Repository and base_branch are required");
      if (!workspaceAllowsRepository(policy, request.repository)) throw new ValidationError(`Repository is not allowed by Workspace policy. The agent owner can update ${repositoryPolicyUrl}`);
      await deps.useCases.checkRepository(context.agentName, context.user, request.repository, request.base_branch);
      return reply({ repository: request.repository, base_branch: request.base_branch, ready: true,
        message: "This Agent's GitHub MCP account can read the base branch. No Workspace, repository or task was created." });
    }
    if (operation === "start" || operation === "run") {
      if (!callId || typeof request.task !== "string") throw new ValidationError("Workspace task identity is missing");
      const key = createHash("sha256").update(JSON.stringify([context.occurrence, context.agentName, callId])).digest("hex");
      if (operation === "start") {
        if (!context.sourceChatId && selectedWorkspaceId) {
          const selected = (await owned(selectedWorkspaceId)).workspace;
          return reply({ ...location(selected), reused: true, task_queued: false, run_id: selected.activeRunId ?? null,
            workspace_status: selected.status, next: selected.activeRunId ? "wait" : "run", after_seq: 0 });
        }
        const runtime = (request.runtime ?? policy.defaultRuntime ?? "command") as WorkspaceRuntime;
        if (!WORKSPACE_RUNTIMES.includes(runtime)) throw new ValidationError("Invalid Workspace runtime");
        if ((request.repository !== null && typeof request.repository !== "string") ||
          (request.base_branch !== null && typeof request.base_branch !== "string")) throw new ValidationError("Invalid repository selection");
        if (request.repository !== null && !workspaceAllowsRepository(policy, request.repository as string)) throw new ValidationError(`Repository is not allowed by Workspace policy. The agent owner can update ${repositoryPolicyUrl}`);
        if ((request.repository === null) !== (request.base_branch === null)) throw new ValidationError("Repository work requires both repository and base_branch");
        if (request.title !== undefined && typeof request.title !== "string") throw new ValidationError("Invalid workspace title");
        const startInput = { agentName: context.agentName, runtime,
          ...(context.reviewTarget ? { sourceRevision: context.reviewTarget.headSha } : {}),
          ...(context.actor ? { actor: context.actor } : {}),
          ...(context.executionGrant ? { executionGrant: context.executionGrant } : {}),
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.repository !== null ? { repository: String(request.repository), baseBranch: String(request.base_branch) } : {}), input: input(runtime, request.task) };
        let started;
        if (context.sourceChatId) started = await deps.useCases.startForChat(startInput, context.user, context.sourceChatId);
        else {
          try { started = { ...await deps.useCases.start(startInput, context.user, startKey), reused: false }; }
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
      const run = await deps.useCases.enqueue(detail.workspace.id, context.user, input(detail.workspace.runtime, request.task), key, context.actor, context.executionGrant);
      return reply({ ...location(detail.workspace), run_id: run.id, status: run.status, next: "wait", after_seq: 0 });
    }
    if (!["status", "wait", "attach_repository", "prepare_git", "cancel", "close"].includes(String(operation))) throw new ValidationError("Unknown Workspace operation");
    let detail = await resolve(request, !["status", "wait"].includes(String(operation)));
    const id = detail.workspace.id;
    if (operation === "attach_repository") {
      if (typeof request.repository !== "string" || typeof request.base_branch !== "string") throw new ValidationError("Repository and base_branch are required");
      if (!workspaceAllowsRepository(policy, request.repository)) throw new ValidationError(`Repository is not allowed by Workspace policy. The agent owner can update ${repositoryPolicyUrl}`);
      const workspace = await deps.attachRepository(id, context.user, request.repository, request.base_branch);
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
      } else if (value.kind === "tag" || value.kind === "release") {
        if (typeof value.tag !== "string" || !isGitBranch(value.tag)) throw new ValidationError("Invalid Git tag");
        if (value.kind === "tag") action = { kind: "tag", tag: value.tag };
        else {
          if (typeof value.title !== "string" || typeof value.body !== "string" || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") throw new ValidationError("Release title, body, draft and prerelease are required");
          action = { kind: "release", tag: value.tag, title: value.title, body: value.body, draft: value.draft, prerelease: value.prerelease };
        }
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
      } else throw new ValidationError("Unsupported Git action. Use commit, commit-and-push, push, pull-request, merge, push-main, tag, release or deploy; do not use a native task or another Workspace");
      if (!codingActionRequiresConfirmation(action)) {
        const publication = await deps.publishGit(id, context, action, context.sourceChatId);
        const updated = await owned(id);
        return reply({ ...location(updated.workspace), action_id: publication.id, action: publication.action,
          status: publication.status, result: publication.result,
          ...(publication.ciWatch ? { ci_watch: publication.ciWatch } : {}),
          next: publication.ciWatch ? "The pull request is published. Its exact HEAD checks are watched for up to 30 minutes; pause this turn. The CI result will resume this chat for the remaining user request. Do not repeat publication or poll repeatedly."
            : publication.status === "succeeded"
            ? "Continue the coding request through a pull request without asking for commit or work-branch push approval. Merge, main publication, tags, releases and deployment need a separate user request and confirmation. Never repeat completed actions."
            : "Report this outcome. Do not repeat an uncertain action or continue dependent publication; inspect status first." }, publication.status !== "succeeded");
      }
      const pending = detail.approvals.find(item => item.id === detail.workspace.activeActionId && item.status === "pending");
      const same = pending && isDeepStrictEqual(pending.action, action);
      const approval = same && pending && pending.sourceChatId === context.sourceChatId && pending.requestedByUserId === context.user.userId ? pending
        : await deps.requestGit(id, context, action, context.sourceChatId);
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
        ? await deps.pullRequest(id, context.user) : detail.workspace.pullRequest ?? null };
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
    const selected: typeof events = [];
    let raw = "";
    let outputBytes = 0;
    for (const event of events.slice(0, 20)) {
      const fragment = event.data.kind === "output" ? event.data.text
        : event.data.kind === "message" || event.data.kind === "warning" ? `\n${event.data.text}\n` : "";
      const bytes = Buffer.byteLength(fragment);
      // Leave the next whole event behind the cursor for the following page.
      // An individually oversized event still advances with explicit truncation.
      if (selected.length && outputBytes + bytes > OUTPUT_BYTES) break;
      selected.push(event);
      raw += fragment;
      outputBytes += bytes;
      if (outputBytes > OUTPUT_BYTES) break;
    }
    const output = boundedWorkspaceText(raw, OUTPUT_BYTES);
    const diff = boundedWorkspaceText(run.diff ?? "", OUTPUT_BYTES);
    const nextSeq = selected.at(-1)?.seq ?? Number(after);
    const hasMore = events.length > selected.length || nextSeq < run.lastEventSeq;
    const terminal = isTerminalWorkspaceRun(run.status);
    return reply({ ...location(detail.workspace), workspace_status: detail.workspace.status,
      run_id: run.id, status: run.status, error: run.error,
      ...git,
      checks: run.checks.map(({ output: _output, ...check }) => { void _output; return check; }),
      output: output.text, diff: diff.text, output_loss: !!run.outputLoss,
      truncated: !!run.outputLoss || output.truncated || diff.truncated || !!run.diffTruncated,
      next_seq: nextSeq, has_more: hasMore,
      next_request: hasMore || !terminal ? { operation: hasMore ? "status" : "wait", workspace_id: id, run_id: run.id, after_seq: nextSeq } : null,
      next: hasMore ? "read remaining output" : terminal ? "review results" : "wait" });
  };
}
