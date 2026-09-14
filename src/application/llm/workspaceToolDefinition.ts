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
  description: "Run persistent file, coding, analysis and automation tasks in an isolated Sandbox. Read options first. start creates a Workspace and queues its first run; run continues the returned workspace_id with the same files and native session. Git is optional: use the configured repository and base branch only for repository work. status reads current results; wait waits briefly for progress and returns its next cursor. Queued/running is not success: continue wait or give the user the returned workspace_path. close saves files and removes compute; a later run restores it. Git commits, PRs, merges and deployment require the user's Workspace approval UI, and cannot be approved by this tool.",
  parameters: object({ request: { anyOf: [
    object({ operation: operation("options") }),
    object({ operation: operation("start"), runtime: { type: "string", enum: WORKSPACE_RUNTIMES },
      repository: nullable(text), base_branch: nullable(text), task }),
    object({ operation: operation("run"), workspace_id: text, task }),
    ...["status", "wait"].map(name => object({ operation: operation(name), workspace_id: text,
      run_id: nullable(text), after_seq: nullable({ type: "integer", minimum: 0 }) })),
    ...["cancel", "close"].map(name => object({ operation: operation(name), workspace_id: text })),
  ] } }),
} };
