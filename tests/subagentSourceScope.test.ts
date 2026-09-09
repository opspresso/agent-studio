import { describe, expect, it, vi } from "vitest";
import { buildMcpTools, type McpToolDeps } from "@/application/execution/mcpTools";
import type { McpServerConfig } from "@/domain/mcp/toolSession";
import type { Version } from "@/domain/project/types";

describe("orchestrated private source ownership", () => {
  it("registers the source under the main Agent while retaining the child connection for refresh", async () => {
    let servers: McpServerConfig[] = [];
    const register = vi.fn(async () => ({ sourceRef: "private-ref", filename: "audio.mp3", mimeType: "audio/mpeg" }));
    const deps = { mcps: { get: async () => ({ name: "files", url: "https://files.example.test/mcp" }) },
      cipher: { mergeOutboundHeaders: () => ({}) }, urlPolicy: { assertAllowed: async () => {} }, registerMcpSource: register,
      sourceRefreshIdentity: async () => "child-connection", mcpSessions: { open: async (value: McpServerConfig[]) => {
        servers = value; return { tools: [], toolNamesByServer: new Map(), warnings: [], unauthorizedServers: [], aliasFor: () => undefined, close: async () => {} };
      } } } as unknown as McpToolDeps;
    const version = { projectName: "downloader", versionName: "2", mcpList: [{ name: "files", sourceOutputs: [
      { tool: "read", namespace: "account", idPath: ["id"], urlPath: ["url"], mimeType: "audio/mpeg", refreshArgument: "id" },
    ] }] } as unknown as Version;
    await buildMcpTools(deps, version, undefined, { actor: { kind: "user", id: "owner@example.test" }, ancestry: ["main", "downloader"] });
    const result = await servers[0]!.resultTransforms!.read!({ content: [{ type: "text", text: JSON.stringify({ id: "recording", url: "https://files.example.test/audio?sig=private" }) }] });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ projectName: "main", userEmail: "owner@example.test",
      refresh: expect.objectContaining({ projectName: "downloader", versionName: "2", identity: "child-connection" }) }));
    expect(result.text).toContain("private-ref");
    expect(result.text).not.toContain("sig=");
  });
});
