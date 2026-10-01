import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAuthProvider } from "@/application/mcp/mcpAuthProvider";
import { mcpRefreshRepository } from "@/infrastructure/db/repositories/mcpRefreshRepository";
import { mcpConnectionRepository } from "@/infrastructure/db/repositories/mcpConnectionRepository";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";
import type { McpConnection } from "@/domain/mcp/connection";
import type { McpServerAuth } from "@/domain/mcp/types";
import type { OAuthClient } from "@/domain/mcp/oauth";
const ids = vi.hoisted(() => ({ sequence: 0 }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => `00000000-0000-4000-8000-${String(++ids.sequence).padStart(12, "0")}` }));
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const now = new Date("2026-10-01T08:00:00Z");
const auth: McpServerAuth = { type: "oauth2", issuer: "https://auth.example.test", authorizationServer: "https://auth.example.test", resource: "https://mcp.example.test",
  authorizationEndpoint: "https://auth.example.test/authorize", tokenEndpoint: "https://auth.example.test/token", tokenEndpointAuthMethod: "none", discoveredAt: now.toISOString() };
const cipher = { decrypt: (value: string) => value.slice(4), encrypt: (value: string) => `enc:${value}` };
let connection: McpConnection;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now); store.rows.clear(); ids.sequence = 0;
  store.seed([{ ...keys.agent("agent"), entityType: "AGENT", name: "agent" }]);
  await mcpConnectionRepository.put({ agentName: "agent", serverName: "server", clientId: "client", issuer: auth.issuer, resource: auth.resource,
    scopes: [], accessToken: "enc:old", refreshToken: "enc:refresh", expiresAt: new Date(now.getTime() + 1000).toISOString(), status: "connected", updatedAt: now.toISOString() });
  connection = (await mcpConnectionRepository.get("agent", "server"))!;
});
afterEach(() => vi.useRealTimers());
const provider = (refresh: OAuthClient["refresh"], sleep: (ms: number) => Promise<void> = async ms => { await vi.advanceTimersByTimeAsync(ms); }) => createMcpAuthProvider({
  connections: mcpConnectionRepository, refreshClaims: mcpRefreshRepository, cipher, sleep,
  oauth: { register: vi.fn(), exchangeCode: vi.fn(), refresh },
});

describe("durable OAuth refresh ownership", () => {
  it("admits only one provider effect across two independent provider instances", async () => {
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<{ accessToken: string; refreshToken: string; expiresInSeconds: number }>();
    const refresh = vi.fn(async () => { entered.resolve(); return finish.promise; });
    const first = provider(refresh).headersFor("agent", "server", auth);
    await entered.promise;
    const second = provider(refresh, async () => { finish.resolve({ accessToken: "new", refreshToken: "rotated", expiresInSeconds: 3600 }); await first; }).headersFor("agent", "server", auth);
    expect((await first).headers.Authorization).toBe("Bearer new");
    expect((await second).headers.Authorization).toBe("Bearer new");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not replay a provider refresh after the claiming process disappears", async () => {
    expect((await mcpRefreshRepository.begin(connection, now.toISOString(), new Date(now.getTime() + 1000).toISOString())).kind).toBe("claimed");
    vi.setSystemTime(new Date(now.getTime() + 2000));
    const refresh = vi.fn();
    const resolution = await provider(refresh).headersFor("agent", "server", auth);
    expect(resolution.unavailable).toContain("uncertain"); expect(refresh).not.toHaveBeenCalled();
    expect((await mcpConnectionRepository.get("agent", "server"))?.status).toBe("needs_reauth");
  });

  it("does not repeat a refresh when its response is lost", async () => {
    const refresh = vi.fn(async () => { throw new Error("Connection lost after dispatch"); });
    expect((await provider(refresh).headersFor("agent", "server", auth)).unavailable).toContain("Connection lost");
    expect((await provider(refresh).headersFor("agent", "server", auth)).unavailable).toContain("reconnected");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a claim from an earlier revision after reconnect", async () => {
    await mcpRefreshRepository.begin(connection, now.toISOString(), new Date(now.getTime() + 1000).toISOString());
    await mcpConnectionRepository.put({ ...connection, accessToken: "enc:reconnected", expiresAt: new Date(now.getTime() + 3600000).toISOString() });
    const refresh = vi.fn(); const resolution = await provider(refresh).headersFor("agent", "server", auth);
    expect(resolution.headers.Authorization).toBe("Bearer reconnected"); expect(refresh).not.toHaveBeenCalled();
  });

  it("fences refresh admission against Agent deletion and a changed grant", async () => {
    store.seed([{ ...keys.agent("agent"), entityType: "AGENT_TOMBSTONE", name: "agent" }]);
    expect((await mcpRefreshRepository.begin(connection, now.toISOString(), new Date(now.getTime() + 1000).toISOString())).kind).toBe("changed");
    expect(await store.getItem(keys.mcpRefresh("agent", "server", connection.revision))).toBeNull();
  });
});
