import type { ChannelToolDef } from "@/domain/llm/channel";
import { WORKSPACE_TOOL_NAME } from "@/domain/llm/toolNames";
import { WORKSPACE_RUNTIMES } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
const text: Schema = { type: "string", minLength: 1, maxLength: 200 };
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const operation = (name: string): Schema => ({ type: "string", enum: [name] });
const task: Schema = { type: "string", minLength: 1, maxLength: WORKSPACE_LIMITS.promptChars,
  description: "The complete task for the selected native agent, or an exact shell script for the command runtime. Include requested changes and validation, not credentials." };

export const WORKSPACE_TOOL_DEF: ChannelToolDef = { type: "function", function: {
  name: WORKSPACE_TOOL_NAME,
  description: "Run persistent file, coding, analysis and automation tasks in an isolated Sandbox. Read options first. start creates a Workspace and queues its first run; run continues the returned workspace_id with the same files and native session. Git is optional. status reads results; wait waits briefly and returns its next cursor. Queued/running is not success. close saves files and removes compute; a later run restores it. For commit or push requests, use prepare_git with commit, commit-and-push or push, then return approval_path and stop for the user's Workspace approval UI. NEVER send git add/commit/push to a native task: /control/git is deliberately protected. Do not change its permissions, use temporary indexes or retry through GitHub tools. This tool cannot approve or execute Git publication.",
  parameters: object({ request: { anyOf: [
    object({ operation: operation("options") }),
    object({ operation: operation("start"), runtime: { type: "string", enum: WORKSPACE_RUNTIMES },
      repository: nullable(text), base_branch: nullable(text), task }),
    object({ operation: operation("run"), workspace_id: text, task }),
    object({ operation: operation("prepare_git"), workspace_id: text, action: { anyOf: [
      object({ kind: { type: "string", enum: ["commit", "commit-and-push"] }, message: { type: "string", minLength: 1, maxLength: 8000 } }),
      object({ kind: operation("push") }),
    ] } }),
    ...["status", "wait"].map(name => object({ operation: operation(name), workspace_id: text,
      run_id: nullable(text), after_seq: nullable({ type: "integer", minimum: 0 }) })),
    ...["cancel", "close"].map(name => object({ operation: operation(name), workspace_id: text })),
  ] } }),
} };
