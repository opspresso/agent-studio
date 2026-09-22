import type { ChannelToolDef } from "@/domain/llm/channel";
import { WORKSPACE_TOOL_NAME } from "@/domain/llm/toolNames";
import { WORKSPACE_RUNTIMES } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties,
  required, additionalProperties: false });
const text: Schema = { type: "string", minLength: 1, maxLength: 200 };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const operation = (name: string): Schema => ({ type: "string", enum: [name] });
const task: Schema = { type: "string", minLength: 1, maxLength: WORKSPACE_LIMITS.promptChars,
  description: "A complete implementation task for codex/claude/opencode, or an exact script for command. Work in the returned workdir with relative paths. Shell scripts stop on failed commands. workspace_path is a web link, not a directory. Include validation, not credentials." };
const runtime: Schema = { type: "string", enum: WORKSPACE_RUNTIMES,
  description: "Prefer codex, claude or opencode for code implementation. command is for exact scripts and simple file/data processing." };
const repository: Schema = nullable({ ...text, description: "The user's requested repository. Select it with base_branch for clone or coding tasks. null deliberately creates a Git-free Workspace; it does not use the configured default repository." });

export const WORKSPACE_TOOL_DEF: ChannelToolDef = { type: "function", function: {
  name: WORKSPACE_TOOL_NAME,
  description: "Run persistent tasks in a Sandbox. Read options for current_workspace and workdir. Before creating any repository, use check_repository_access with its exact owner/name. Access modes are selected, owners, all and new. In new mode, creation_allowed can be true while existing access is false. For a requested new repository use Workspace create_repository, which initializes it and automatically registers a confirmed creation. Never use MCP creation or a claimed creation date to bypass registration. If both access and creation are blocked, return repository_policy_url. Then use check_repository with the returned base_branch before cloning. A chat keeps one selected Workspace per project: start creates it once; another start returns it WITHOUT running another task. Use run for follow-ups; workspace_id can be omitted when selected. use_workspace selects an existing owned Workspace. attach_repository connects Git to an empty Git-free workdir; it never detaches Git or changes runtime. Set repository AND base_branch for clone/coding; null means Git-free. Use returned workspace_url and approval_url verbatim as browser links; path fields are relative web paths, never hostnames or directories. Use relative paths in workdir. status/wait report actual progress. Use prepare_git for commit, commit-and-push, push to the work branch, pull-request with title/body/draft, merge with pullRequestNumber/headSha from status.pull_request, or push-main for direct fast-forward publication of an already pushed branch. For requested deployment, use deploy with a workflow from options.deployment_workflows, ref main and inputs as name/value pairs; [] means no inputs. Approval dispatches the workflow, not proof of successful deployment. Return approval_url (or the relative approval_path) and pause this turn. For requests from a chat, the decision outcome is delivered there and the agent resumes automatically; read status and prepare the next requested action for its own review. close only when the user ends the Workspace; it preserves the selection and files. run and prepare_git restore closed Workspaces. Never close/start to publish, change runtime or recover a tool error. New run cancels pending Git review; executing/uncertain actions stay blocked. NEVER run Git writes, curl GitHub writes, permission/index workarounds or credential requests in native tasks.",
  parameters: object({ request: { anyOf: [
    object({ operation: operation("options") }),
    object({ operation: operation("check_repository_access"), repository: text }),
    object({ operation: operation("create_repository"), repository: text,
      description: { type: "string", maxLength: WORKSPACE_LIMITS.repositoryDescriptionChars }, private: { type: "boolean", description: "Follow requested visibility; default to private when unspecified." } }),
    object({ operation: operation("check_repository"), repository: text, base_branch: text }),
    object({ operation: operation("start"), runtime: nullable(runtime), repository, base_branch: nullable(text), task }),
    object({ operation: operation("run"), workspace_id: nullable(text), task, runtime: nullable(runtime), repository,
      base_branch: nullable(text) }, ["operation", "task"]),
    object({ operation: operation("use_workspace"), workspace_id: text }),
    object({ operation: operation("attach_repository"), workspace_id: nullable(text), repository: text, base_branch: text }, ["operation", "repository", "base_branch"]),
    object({ operation: operation("prepare_git"), workspace_id: nullable(text), action: { anyOf: [
      object({ kind: { type: "string", enum: ["commit", "commit-and-push"] }, message: { type: "string", minLength: 1, maxLength: 8000 } }),
      object({ kind: operation("push") }),
      object({ kind: operation("push-main") }),
      object({ kind: operation("pull-request"), title: text, body: { type: "string", maxLength: 40_000 }, draft: { type: "boolean" } }),
      object({ kind: operation("merge"), pullRequestNumber: { type: "integer", minimum: 1 }, headSha: { type: "string", pattern: "^[a-f0-9]{40,64}$" } }),
      object({ kind: operation("deploy"), workflow: { ...text, description: "An exact workflow from options.deployment_workflows. This prepares approval; it does not execute or verify a deployment." },
        ref: { type: "string", enum: ["main"] },
        inputs: { type: "array", items: object({ name: text, value: { type: "string" } }),
          description: "Workflow inputs as unique name/value pairs. Use [] when no inputs are needed. Never include credentials." } }),
    ] } }, ["operation", "action"]),
    ...["status", "wait"].map(name => object({ operation: operation(name), workspace_id: nullable(text),
      run_id: nullable(text), after_seq: nullable({ type: "integer", minimum: 0 }) }, ["operation"])),
    ...["cancel", "close"].map(name => object({ operation: operation(name), workspace_id: nullable(text) }, ["operation"])),
  ] } }),
} };
