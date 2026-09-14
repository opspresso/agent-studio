import type { WorkspaceRuntimeAdapter, SandboxCommand } from "@/domain/workspace/ports";
import type { WorkspaceRuntime, WorkspaceEventData } from "@/domain/workspace/types";

export interface WorkspaceRuntimeConfig {
  model?: string;
  environment?: Record<string, string>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function message(value: string): WorkspaceEventData[] { return value ? [{ kind: "message", text: value }] : []; }
function output(value: string): WorkspaceEventData[] { return value ? [{ kind: "output", stream: "stdout", text: value }] : []; }
function session(value: unknown): WorkspaceEventData[] {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? [{ kind: "session", nativeSessionId: value }] : [];
}

function codexEvents(event: Record<string, unknown>): WorkspaceEventData[] {
  if (event.type === "thread.started") return session(event.thread_id);
  if (event.type === "turn.failed" || event.type === "error") {
    return [{ kind: "status", status: "failed", text: text(object(event.error).message) || text(event.message) || "Codex execution failed" }];
  }
  const item = object(event.item);
  if (event.type === "item.started" && item.type === "command_execution") return output(`$ ${text(item.command)}\n`);
  if (event.type !== "item.completed") return [];
  if (item.type === "agent_message") return message(text(item.text));
  if (item.type === "command_execution") return output(text(item.aggregated_output));
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return output(item.changes.map(change => `${text(object(change).kind)} ${text(object(change).path)}`).join("\n") + "\n");
  }
  return [];
}

function claudeEvents(event: Record<string, unknown>): WorkspaceEventData[] {
  if (event.type === "system" && event.subtype === "init") return session(event.session_id);
  if (event.type === "stream_event") {
    const delta = object(object(event.event).delta);
    return delta.type === "text_delta" ? message(text(delta.text)) : [];
  }
  if (event.type === "result" && event.is_error === true) {
    return [{ kind: "status", status: "failed", text: text(event.result) || "Claude execution failed" }];
  }
  const content = object(event.message).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap(value => {
    const block = object(value);
    if (block.type === "tool_use") return output(`${text(block.name)} ${JSON.stringify(block.input ?? {})}\n`);
    if (block.type === "tool_result") {
      const result = typeof block.content === "string" ? block.content : Array.isArray(block.content)
        ? block.content.map(part => text(object(part).text)).join("\n") : "";
      return output(result);
    }
    return [];
  });
}

function opencodeEvents(event: Record<string, unknown>): WorkspaceEventData[] {
  const events = session(event.sessionID);
  const part = object(event.part);
  if (event.type === "text") events.push(...message(text(part.text)));
  if (event.type === "tool_use") {
    const state = object(part.state);
    events.push(...output(`${text(part.tool)} ${JSON.stringify(state.input ?? {})}\n${text(state.output)}`));
  }
  if (event.type === "error") events.push({ kind: "status", status: "failed", text: text(object(event.error).message) || "OpenCode execution failed" });
  return events;
}

/** Arguments are literal arrays; only the explicitly selected command runtime interprets a script. */
export function createWorkspaceRuntimeAdapter(kind: WorkspaceRuntime, config: WorkspaceRuntimeConfig = {}): WorkspaceRuntimeAdapter {
  return {
    kind,
    command(_workspace, current, input, timeoutMs): SandboxCommand {
      if (current.runtime !== kind) throw new Error("Runtime session kind mismatch");
      const cwd = "/workspace/repo";
      if (kind === "command") {
        if (input.kind !== "command") throw new Error("Command runtime requires a script");
        return { argv: ["/bin/sh", "-s"], stdin: input.script, cwd, timeoutMs };
      }
      if (input.kind !== "task") throw new Error("Agent runtime requires task input");
      const model = config.model ? ["--model", config.model] : [];
      const resume = current.nativeSessionId;
      if (resume && !/^[a-zA-Z0-9_-]{1,200}$/.test(resume)) throw new Error("Invalid native runtime session id");
      const environment = config.environment;
      if (kind === "codex") return {
        argv: ["codex", "exec", ...(resume ? ["resume"] : []), "--json", "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
          ...["plugins", "remote_plugin", "apps", "hooks", "skill_mcp_dependency_install"].flatMap(feature => ["--disable", feature]),
          ...model, ...(resume ? [resume] : []), "-"],
        stdin: input.prompt, cwd, timeoutMs, environment,
      };
      if (kind === "claude") return {
        argv: ["claude", "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
          "--dangerously-skip-permissions", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          ...model, ...(resume ? ["--resume", resume] : ["--session-id", current.id])],
        stdin: input.prompt, cwd, timeoutMs, environment,
      };
      return { argv: ["opencode", "run", "--pure", "--format", "json", "--auto", ...model,
        ...(resume ? ["--session", resume] : []), "--", input.prompt], cwd, timeoutMs, environment };
    },
    events(line) {
      if (kind === "command") return output(line);
      let event: Record<string, unknown>;
      try { event = object(JSON.parse(line)); }
      catch { return output(line + "\n"); }
      return kind === "codex" ? codexEvents(event) : kind === "claude" ? claudeEvents(event) : opencodeEvents(event);
    },
  };
}
