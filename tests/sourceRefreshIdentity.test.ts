import { describe, expect, it } from "vitest";
import { sourceRefreshFingerprint } from "@/application/audio/sourceRefreshIdentity";
import type { McpServer } from "@/domain/mcp/types";
import type { McpConnection } from "@/domain/mcp/connection";
const server: McpServer = { name: "files", url: "https://files.example.test/mcp", headers: {}, createdAt: "before", updatedAt: "before",
  auth: { type: "oauth2", resource: "https://files.example.test/mcp", issuer: "https://auth.example.test", authorizationServer: "https://auth.example.test",
    authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token", tokenEndpointAuthMethod: "none", discoveredAt: "before" } };
const binding = { name: "files" };
const connection = { projectName: "audio", serverName: "files", clientId: "client", issuer: "https://auth.example.test",
  resource: "https://files.example.test/mcp", status: "connected", connectedAt: "2026-09-09T00:00:00Z", connectedBy: "owner@example.test", updatedAt: "before" } as McpConnection;
describe("source refresh identity", () => {
  it("fences changed defaults but ignores defaults under an explicit Agent binding override", () => {
    const defaults = [{ tool: "read", namespace: "files", idPath: ["id"], urlPath: ["url"], mimeType: "audio/mpeg" }];
    const next = { ...server, sourceOutputs: defaults };
    expect(sourceRefreshFingerprint(next, binding, connection)).not.toBe(sourceRefreshFingerprint(server, binding, connection));
    const override = { ...binding, sourceOutputs: [] };
    expect(sourceRefreshFingerprint(next, override, connection)).toBe(sourceRefreshFingerprint(server, override, connection));
  });
  it("does not change when OAuth access tokens rotate", () => {
    const first = sourceRefreshFingerprint(server, binding, connection);
    expect(sourceRefreshFingerprint(server, binding, { ...connection, accessToken: "rotated", updatedAt: "after" } as McpConnection)).toBe(first);
    expect(sourceRefreshFingerprint(server, binding, { ...connection, connectedAt: "2026-09-09T01:00:00Z" })).not.toBe(first);
    expect(sourceRefreshFingerprint(server, binding, { ...connection, authorizationEpoch: "new-flow-at-same-time" })).not.toBe(first);
  });
  it("changes when an endpoint, static credential or binding is replaced", () => {
    const first = sourceRefreshFingerprint(server, binding, connection);
    expect(sourceRefreshFingerprint({ ...server, url: "https://other.example.test/mcp" }, binding, connection)).not.toBe(first);
    expect(sourceRefreshFingerprint({ ...server, headers: { Authorization: "new-credential" } }, binding, connection)).not.toBe(first);
    expect(sourceRefreshFingerprint(server, { ...binding, headers: { Authorization: "new-binding" } }, connection)).not.toBe(first);
  });
});
