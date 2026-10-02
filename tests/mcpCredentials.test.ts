import { describe, expect, it, vi } from "vitest";
import { resolveMcpCredentials } from "@/application/mcp/credentials";
import { mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import type { McpServer } from "@/domain/mcp/types";

const user = { userId: "caller-id", email: "caller@example.test" };
const server: McpServer = { name: "fixture", url: "https://mcp.example.test/mcp", headers: {}, createdAt: "2026-10-01", updatedAt: "2026-10-01",
  auth: { type: "oauth2", issuer: "https://auth.example.test", authorizationServer: "https://auth.example.test", resource: "https://mcp.example.test/mcp",
    authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token", tokenEndpointAuthMethod: "none", discoveredAt: "2026-10-01" } };
const fixture = (headers: Record<string, string>, unavailable?: string) => ({ cipher: secretCipher,
  auth: { headersFor: vi.fn(async () => ({ headers, unavailable })), markUnauthorized: vi.fn(async () => {}) } });

describe("shared MCP credential dispatch", () => {
  it("sends one OAuth Authorization value after replacing registry and Agent spellings case-insensitively", async () => {
    const deps = fixture({ Authorization: "Bearer oauth-account" });
    const resolved = await resolveMcpCredentials(deps, "agent", { ...server, headers: { authorization: "Bearer registry-account" } },
      { headers: { AUTHORIZATION: "Bearer static-account", "X-API-Key": "static-key" }, headerTarget: mcpHeaderTarget(server.url) }, user);
    const outbound = new Headers(resolved.headers);
    expect(outbound.get("authorization")).toBe("Bearer oauth-account");
    expect(outbound.get("x-api-key")).toBe("static-key");
    expect(deps.auth.headersFor).toHaveBeenCalledExactlyOnceWith(user.userId, server.name, server.auth);
  });

  it("never treats configured user, tenant or conversation metadata as authentication", async () => {
    const deps = fixture({}, "The Agent has not connected this server");
    const resolved = await resolveMcpCredentials(deps, "agent", { ...server,
      headers: { "x-user-email": "other@example.test", "X-Tenant-Id": "other-agent", "X-CONVERSATION-ID": "other-conversation" } }, undefined, user);
    expect(resolved.headers).toEqual({});
    expect(resolved.unavailable).toBe("The Agent has not connected this server");
  });

  it("refuses shared authentication when the caller has no OAuth grant", async () => {
    const deps = fixture({}, "OAuth is not connected");
    const resolved = await resolveMcpCredentials(deps, "agent", { ...server, headers: { "X-API-Key": "operator-key" } }, undefined, user);
    expect(resolved.headers).toEqual({});
    expect(resolved.unavailable).toBe("OAuth is not connected");
  });

  it("drops stale Agent secrets but preserves explicit default removals and reports the loss", async () => {
    const deps = fixture({});
    const resolved = await resolveMcpCredentials(deps, "agent", { ...server, auth: undefined, headers: { Authorization: "Bearer default" } },
      { headerTarget: mcpHeaderTarget("https://previous.example.test/mcp"), headers: { Authorization: null, "X-API-Key": "old-endpoint-secret" } });
    expect(resolved.headers).toEqual({});
    expect(resolved.warning).toContain("moved");
    expect(deps.auth.headersFor).not.toHaveBeenCalled();
  });
});
