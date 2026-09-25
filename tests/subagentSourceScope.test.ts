import { describe, expect, it, vi } from "vitest";
import { buildMcpTools, type McpToolDeps } from "@/application/execution/mcpTools";
import type { McpServerConfig } from "@/domain/mcp/toolSession";
import type { AgentConfiguration } from "@/domain/agent/types";

describe("orchestrated private source ownership", () => {
  it("uses plugin mappings by default, scopes accounts, and honors an empty override", async () => {
    let servers: McpServerConfig[] = [];
    let identity = "connection-1";
    const mapping = { tool: "read", namespace: "files", idPath: ["id"], urlPath: ["url"], mimeType: "audio/mpeg", refreshArgument: "id" };
    const register = vi.fn(async () => ({ sourceRef: "private-ref", filename: "source", mimeType: "audio/mpeg" }));
    const deps = { mcps: { get: async () => ({ name: "files", url: "https://files.example.test/mcp", sourceOutputs: [mapping] }) },
      cipher: { mergeOutboundHeaders: () => ({}) }, urlPolicy: { assertAllowed: async () => {} }, registerMcpSource: register,
      sourceRefreshIdentity: async () => identity, mcpSessions: { open: async (value: McpServerConfig[]) => {
        servers = value; return { tools: [], toolNamesByServer: new Map(), warnings: [], unauthorizedServers: [], aliasFor: () => undefined, close: async () => {} };
      } } } as unknown as McpToolDeps;
    const configuration = { agentName: "audio", mcpList: [{ name: "files" }] } as unknown as AgentConfiguration;
    const raw = { content: [{ type: "text", text: JSON.stringify({ id: "recording", url: "https://files.example.test/audio?sig=private" }) }] };
    await buildMcpTools(deps, configuration, undefined, { userEmail: "owner@example.test" });
    expect((await servers[0]!.resultTransforms!.read!(raw)).text).not.toContain("sig=");
    const first = vi.mocked(register).mock.calls[0] as unknown as [{ namespace: string }];
    identity = "connection-2";
    await buildMcpTools(deps, configuration, undefined, { userEmail: "owner@example.test" });
    await servers[0]!.resultTransforms!.read!(raw);
    const second = vi.mocked(register).mock.calls[1] as unknown as [{ namespace: string }];
    expect(second[0].namespace).not.toBe(first[0].namespace);
    await buildMcpTools(deps, { ...configuration, mcpList: [{ name: "files", sourceOutputs: [] }] }, undefined, { userEmail: "owner@example.test" });
    expect(servers[0]!.resultTransforms).toBeUndefined();
  });
  it("registers the source under the main Agent while retaining the child connection for refresh", async () => {
    let servers: McpServerConfig[] = [];
    const register = vi.fn(async () => ({ sourceRef: "private-ref", filename: "audio.mp3", mimeType: "audio/mpeg" }));
    const deps = { mcps: { get: async () => ({ name: "files", url: "https://files.example.test/mcp" }) },
      cipher: { mergeOutboundHeaders: () => ({}) }, urlPolicy: { assertAllowed: async () => {} }, registerMcpSource: register,
      sourceRefreshIdentity: async () => "child-connection", mcpSessions: { open: async (value: McpServerConfig[]) => {
        servers = value; return { tools: [], toolNamesByServer: new Map(), warnings: [], unauthorizedServers: [], aliasFor: () => undefined, close: async () => {} };
      } } } as unknown as McpToolDeps;
    const configuration = { agentName: "downloader", mcpList: [{ name: "files", sourceOutputs: [
      { tool: "read", namespace: "account", idPath: ["id"], urlPath: ["url"], mimeType: "audio/mpeg", refreshArgument: "id" },
    ] }] } as unknown as AgentConfiguration;
    await buildMcpTools(deps, configuration, undefined, { actor: { kind: "user", id: "owner@example.test" }, ancestry: ["main", "downloader"] });
    const result = await servers[0]!.resultTransforms!.read!({ content: [{ type: "text", text: JSON.stringify({ id: "recording", url: "https://files.example.test/audio?sig=private" }) }] });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ agentName: "main", userEmail: "owner@example.test",
      refresh: expect.objectContaining({ agentName: "downloader", identity: "child-connection" }) }));
    expect(result.text).toContain("private-ref");
    expect(result.text).not.toContain("sig=");
  });
});
