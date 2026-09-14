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
  description: "Run persistent tasks in a Sandbox. Read options for current_workspace and workdir. A chat keeps one selected Workspace per project: start creates it once; another start returns it WITHOUT running another task. Use run for follow-ups; workspace_id can be omitted when this chat has a selection. use_workspace selects an existing owned Workspace without creating or running anything. attach_repository connects Git to an empty Git-free workdir while keeping the same Workspace. Set repository AND base_branch when the user requests clone/coding; null means Git-free. workspace_path is a BROWSER LINK, never a filesystem path. Use relative paths in workdir. status/wait report actual progress; queued/running is not success. close saves files and removes compute. New run cancels an unapproved Git review; executing/uncertain actions remain blocked. For commit/push use prepare_git, return approval_path and stop for user approval. NEVER run Git writes or permission/index workarounds in a native task, or retry via GitHub tools.",
  parameters: object({ request: { anyOf: [
    object({ operation: operation("options") }),
    object({ operation: operation("start"), runtime, repository, base_branch: nullable(text), task }),
    object({ operation: operation("run"), workspace_id: nullable(text), task, runtime: nullable(runtime), repository,
      base_branch: nullable(text) }, ["operation", "task"]),
    object({ operation: operation("use_workspace"), workspace_id: text }),
    object({ operation: operation("attach_repository"), workspace_id: nullable(text), repository: text, base_branch: text }, ["operation", "repository", "base_branch"]),
    object({ operation: operation("prepare_git"), workspace_id: nullable(text), action: { anyOf: [
      object({ kind: { type: "string", enum: ["commit", "commit-and-push"] }, message: { type: "string", minLength: 1, maxLength: 8000 } }),
      object({ kind: operation("push") }),
    ] } }, ["operation", "action"]),
    ...["status", "wait"].map(name => object({ operation: operation(name), workspace_id: nullable(text),
      run_id: nullable(text), after_seq: nullable({ type: "integer", minimum: 0 }) }, ["operation"])),
    ...["cancel", "close"].map(name => object({ operation: operation(name), workspace_id: nullable(text) }, ["operation"])),
  ] } }),
} };
