import { describe, expect, it } from "vitest";
import { buildMcpTools, type McpToolDeps } from "@/application/execution/mcpTools";
import { sourceRefreshFingerprint } from "@/application/audio/sourceRefreshIdentity";
import type { AgentConfiguration } from "@/domain/agent/types";
import type { McpConnection } from "@/domain/mcp/connection";
import type { McpServer } from "@/domain/mcp/types";

function fixture() {
  const server = { name: "github", url: "https://mcp.example.test", headers: {}, auth: { type: "oauth2" } } as McpServer;
  const configuration = { agentName: "code", mcpList: [{ name: "github" }] } as AgentConfiguration;
  const connection = { status: "connected", authorizationEpoch: "first", accessToken: "access-1" } as McpConnection;
  const deps = { mcps: { get: async () => server }, urlPolicy: { assertAllowed: async () => {} },
    cipher: { mergeOutboundHeaders: () => ({}) },
    mcpAuth: { headersFor: async () => ({ headers: { Authorization: `Bearer ${connection.accessToken}` } }), markUnauthorized: async () => {} },
    sourceRefreshIdentity: async () => sourceRefreshFingerprint(server, configuration.mcpList[0]!, connection),
    mcpSessions: { open: async () => ({ tools: [{ type: "function", function: { name: "write", parameters: {} } }],
      toolNamesByServer: new Map([["github", ["write"]]]), warnings: [], unauthorizedServers: [],
      callTool: async () => ({ text: "done" }), aliasFor: () => "write", close: async () => {} }) },
  } as unknown as McpToolDeps;
  return { server, connection, deps, configuration, signature: async () => (await buildMcpTools(deps, configuration, undefined, { user: { userId: "p", email: "owner@example.test" } })).signature };
}
describe("MCP approval binding identity", () => {
  it("preserves approvals across token refresh and invalidates them after reauthorization", async () => {
    const f = fixture(); const first = await f.signature();
    f.connection.accessToken = "access-2";
    expect(await f.signature()).toBe(first);
    f.connection.authorizationEpoch = "second";
    expect(await f.signature()).not.toBe(first);
  });
  it("invalidates approvals when static credentials change without exposing either credential", async () => {
    const f = fixture(); delete f.server.auth;
    f.server.headers = { Authorization: "secret-one" }; const first = await f.signature();
    f.server.headers = { Authorization: "secret-two" }; const second = await f.signature();
    expect(second).not.toBe(first); expect(first + second).not.toContain("secret-");
  });
  it("refuses mixed credentials if reauthorization races with resolution", async () => {
    const f = fixture(); f.deps.mcpAuth.headersFor = async () => {
      f.connection.authorizationEpoch = "new-account";
      return { headers: { Authorization: "old-account-token" } };
    };
    const result = await buildMcpTools(f.deps, f.configuration, undefined, { user: { userId: "p", email: "owner@example.test" } });
    expect(result.warnings.join(" ")).toContain("authentication changed");
  });
});
