import { describe, expect, it } from "vitest";
import { createWorkspaceRuntimeAdapter, withWorkspaceModelChannel } from "@/infrastructure/workspace/runtimeAdapters";
import { createDockerSandboxProvider } from "@/infrastructure/workspace/dockerProvider";
import type { Workspace, RuntimeSession, WorkspaceRuntime } from "@/domain/workspace/types";

function fixtures(runtime: WorkspaceRuntime, nativeSessionId?: string): [Workspace, RuntimeSession] {
  return [{ id: "workspace-1", chatId: "chat-1", title: "Task", ownerEmail: "owner@example.test", projectName: "demo",
    runtime, sessionId: "49d8f2ee-a602-4c45-bb60-e541cb4bbb82", revision: 0, status: "active", createdAt: "", updatedAt: "", dueAt: "", idleTtlSeconds: 3600 },
  { id: "49d8f2ee-a602-4c45-bb60-e541cb4bbb82", workspaceId: "workspace-1", runtime, nativeSessionId, createdAt: "", updatedAt: "" }];
}

describe("native workspace runtime adapters", () => {
  it("binds a configured model channel without copying unrelated host credentials", () => {
    const channel = { name: "openai", baseUrl: "https://model.example/v1", apiKey: "test-model-key" };
    const codex = withWorkspaceModelChannel("codex", { model: "model-id" }, channel);
    expect(codex.environment).toEqual({ CODEX_API_KEY: channel.apiKey, OPENAI_BASE_URL: channel.baseUrl });
    const claude = withWorkspaceModelChannel("claude", {}, { ...channel, name: "anthropic" });
    expect(claude.environment?.ANTHROPIC_BASE_URL).toBe("https://model.example");
    const opencode = withWorkspaceModelChannel("opencode", { model: "openai/model-id" }, channel);
    expect(JSON.parse(opencode.environment!.OPENCODE_CONFIG_CONTENT!).provider.openai.models).toHaveProperty("model-id");
    expect(() => withWorkspaceModelChannel("command", {}, channel)).toThrow();
    expect(() => withWorkspaceModelChannel("codex", {}, { ...channel, auth: "sigv4" })).toThrow();
  });
  it("uses stdin for explicit general scripts without a Git dependency", () => {
    const command = createWorkspaceRuntimeAdapter("command").command(...fixtures("command"), { kind: "command", script: "echo 'general task'" }, 1000);
    expect(command.argv).toEqual(["/bin/sh", "-s"]);
    expect(command.stdin).toBe("echo 'general task'");
    expect(command.environment).toBeUndefined();
  });
  it.each(["codex", "claude", "opencode"] as const)("%s resumes its exact native session and passes task text literally", runtime => {
    const adapter = createWorkspaceRuntimeAdapter(runtime);
    const prompt = "$(touch /tmp/host-escape) `echo injection`";
    const command = adapter.command(...fixtures(runtime, "existing-session"), { kind: "task", prompt }, 1000);
    expect(command.argv).toContain("existing-session");
    expect(command.stdin === prompt || command.argv.includes(prompt)).toBe(true);
    expect(command.argv[0]).toBe(runtime === "opencode" ? "opencode" : runtime);
    expect(() => adapter.command(...fixtures(runtime, "bad/../session"), { kind: "task", prompt }, 1000)).toThrow("session id");
  });
  it("translates Codex session, command, file, text and failure events", () => {
    const adapter = createWorkspaceRuntimeAdapter("codex");
    expect(adapter.events('{"type":"thread.started","thread_id":"thread-1"}')).toEqual([{ kind: "session", nativeSessionId: "thread-1" }]);
    expect(adapter.events('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}')).toEqual([{ kind: "message", text: "Done" }]);
    expect(adapter.events('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"passed"}}')[0]).toMatchObject({ kind: "output", text: "passed" });
    expect(adapter.events('{"type":"item.completed","item":{"type":"file_change","changes":[{"kind":"update","path":"app.ts"}]}}')[0]).toMatchObject({ kind: "output", text: "update app.ts\n" });
    expect(adapter.events('{"type":"turn.failed","error":{"message":"quota"}}')[0]).toMatchObject({ kind: "status", status: "failed", text: "quota" });
  });
  it("translates Claude partial messages without duplicating complete assistant text", () => {
    const adapter = createWorkspaceRuntimeAdapter("claude");
    const command = adapter.command(...fixtures("claude"), { kind: "task", prompt: "Write a report" }, 1000);
    expect(JSON.parse(command.argv[command.argv.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: {} });
    expect(adapter.events('{"type":"system","subtype":"init","session_id":"session-1"}')[0]).toMatchObject({ kind: "session", nativeSessionId: "session-1" });
    expect(adapter.events('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hello"}}}')).toEqual([{ kind: "message", text: "hello" }]);
    expect(adapter.events('{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}')).toEqual([]);
    expect(adapter.events('{"type":"result","is_error":true,"result":"failed"}')[0]).toMatchObject({ status: "failed" });
  });
  it("translates OpenCode session and tool events and preserves unstructured output", () => {
    const adapter = createWorkspaceRuntimeAdapter("opencode");
    expect(adapter.events('{"type":"text","sessionID":"ses_1","part":{"text":"done"}}')).toEqual([
      { kind: "session", nativeSessionId: "ses_1" }, { kind: "message", text: "done" },
    ]);
    expect(adapter.events('{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"test"},"output":"passed"}}}')[0]).toMatchObject({ kind: "output" });
    expect(adapter.events("CLI diagnostic")).toEqual([{ kind: "output", stream: "stdout", text: "CLI diagnostic\n" }]);
  });
});

describe("Docker sandbox configuration", () => {
  const config = { image: "workspace:test", network: "none", memoryMb: 1024, diskMb: 1024, cpus: 1 };
  it.each(["host", "bridge", "default", "container:other", "--privileged"])("refuses unsafe network %s", network => {
    expect(() => createDockerSandboxProvider({ ...config, network })).toThrow("configuration");
  });
  it("accepts offline or operator-owned network and bounds resource settings", () => {
    expect(createDockerSandboxProvider(config).kind).toBe("docker");
    expect(createDockerSandboxProvider({ ...config, network: "workspace-egress" }).kind).toBe("docker");
    expect(() => createDockerSandboxProvider({ ...config, memoryMb: NaN })).toThrow("configuration");
    expect(() => createDockerSandboxProvider({ ...config, cpus: 0 })).toThrow("configuration");
  });
});
