import { beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "@/infrastructure/db/keys";
import type { FakeStore } from "./fakeStore";

/** Records what was written and answers reads from it. */
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { mcpRepository } = await import("@/infrastructure/db/repositories/mcpRepository");
const { mcpConnectionRepository } = await import(
  "@/infrastructure/db/repositories/mcpConnectionRepository"
);
import type { McpServer } from "@/domain/mcp/types";
import type { McpConnection } from "@/domain/mcp/connection";

beforeEach(() => {
  store.rows.clear();
  store.seed([{ ...keys.agent("p"), entityType: "AGENT", name: "p" }]);
});

/**
 * The mapper names its fields one by one, so a field added to the entity is
 * simply dropped until it is added here too — silently, which for `runtime`
 * means a managed entry reads back as remote and loses the only thing that
 * makes its address reachable.
 */
describe("mcp repository mapping", () => {
  it("round-trips the fields a managed entry depends on", async () => {
    const server: McpServer = {
      name: "image-fetch",
      runtime: "managed",
      url: "http://127.0.0.1:3204/mcp",
      image: "mcp-image-fetch:local",
      environment: { API_TOKEN: "enc:v1:ciphertext" },
      args: ["--transport", "streamable-http"],
      endpointPath: "/custom-mcp",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await mcpRepository.put(server);

    const stored = await store.getItem(keys.mcp("image-fetch"));
    expect(stored?.runtime).toBe("managed");
    expect(stored?.image).toBe("mcp-image-fetch:local");
    expect(stored?.environment).toEqual({ API_TOKEN: "enc:v1:ciphertext" });
    expect(stored?.args).toEqual(["--transport", "streamable-http"]);
    expect(stored?.endpointPath).toBe("/custom-mcp");

    const read = await mcpRepository.get("image-fetch");
    expect(read?.runtime).toBe("managed");
    expect(read?.image).toBe("mcp-image-fetch:local");
    expect(read?.args).toEqual(["--transport", "streamable-http"]);
    expect(read?.environment).toEqual({ API_TOKEN: "enc:v1:ciphertext" });
    expect(read?.endpointPath).toBe("/custom-mcp");
    expect(read?.url).toBe("http://127.0.0.1:3204/mcp");
  });

  it("reads a row written before managed servers existed as remote", async () => {
    store.seed([
      {
        ...keys.mcp("github"),
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const read = await mcpRepository.get("github");
    expect(read?.runtime).toBeUndefined();
  });
});

describe("mcp connection mapping", () => {
  it("prevents stale writes and disconnects from replacing a newer grant", async () => {
    const connection: McpConnection = {
      agentName: "p", serverName: "slack", clientId: "first",
      issuer: "https://auth.example.com", resource: "https://mcp.example.com",
      scopes: [], status: "needs_auth", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await mcpConnectionRepository.putIfCurrent(connection, null)).toBe(true);
    const first = (await mcpConnectionRepository.get("p", "slack"))!;
    expect(await mcpConnectionRepository.putIfCurrent({ ...connection, clientId: "second" }, first)).toBe(true);
    const second = (await mcpConnectionRepository.get("p", "slack"))!;

    expect(await mcpConnectionRepository.putIfCurrent({ ...connection, clientId: "stale" }, first)).toBe(false);
    expect(await mcpConnectionRepository.deleteIfCurrent(first)).toBe(false);
    expect((await mcpConnectionRepository.get("p", "slack"))?.clientId).toBe("second");

    expect(await mcpConnectionRepository.deleteIfCurrent(second)).toBe(true);
    expect(await mcpConnectionRepository.putIfCurrent(connection, second)).toBe(false);
    expect(await mcpConnectionRepository.get("p", "slack")).toBeNull();
  });

  it.each([undefined, "enc:unchanged-refresh"])(
    "changes the revision on every put and token update with refresh token %s",
    async (refreshToken) => {
      const connection: McpConnection = {
        agentName: "p",
        serverName: "slack",
        clientId: "client",
        issuer: "https://auth.example.com",
        resource: "https://mcp.slack.com",
        scopes: [],
        accessToken: "enc:unchanged-access",
        refreshToken,
        status: "connected",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await mcpConnectionRepository.put(connection);
      const first = await mcpConnectionRepository.get("p", "slack");
      expect(first?.revision).toBeTruthy();

      // Rewriting exactly the same grant, even echoing its revision back,
      // must invalidate every snapshot taken before the write.
      await mcpConnectionRepository.put({ ...connection, revision: first?.revision });
      const second = await mcpConnectionRepository.get("p", "slack");
      expect(second?.revision).toBeTruthy();
      expect(second?.revision).not.toBe(first?.revision);
      const next = {
        accessToken: connection.accessToken,
        refreshToken,
        status: connection.status,
        updatedAt: connection.updatedAt,
      };
      await expect(mcpConnectionRepository.updateTokens("p", "slack", first?.revision, next))
        .resolves.toBe(false);
      await expect(Promise.all([
        mcpConnectionRepository.updateTokens("p", "slack", second?.revision, next),
        mcpConnectionRepository.updateTokens("p", "slack", second?.revision, next),
      ])).resolves.toEqual([true, false]);
      const third = await mcpConnectionRepository.get("p", "slack");
      expect(third?.revision).toBeTruthy();
      expect(third?.revision).not.toBe(second?.revision);
      expect(third).toMatchObject(connection);
    },
  );

  it("assigns an unversioned row's first revision under the atomic CAS", async () => {
    store.seed([{
      ...keys.mcpConnection("p", "slack"),
      agentName: "p",
      serverName: "slack",
      clientId: "client",
      issuer: "https://auth.example.com",
      resource: "https://mcp.slack.com",
      scopes: [],
      status: "connected",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]);
    const snapshot = await mcpConnectionRepository.get("p", "slack");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.revision).toBeUndefined();
    const next = { status: "connected" as const, updatedAt: "2026-01-01T00:00:00.000Z" };

    await expect(Promise.all([
      mcpConnectionRepository.updateTokens("p", "slack", snapshot?.revision, next),
      mcpConnectionRepository.updateTokens("p", "slack", snapshot?.revision, next),
    ])).resolves.toEqual([true, false]);
    expect((await mcpConnectionRepository.get("p", "slack"))?.revision).toBeTruthy();
  });

  it("round-trips the flag that decides whether the issuer check applies", async () => {
    // The write spreads the whole connection while the read names its fields, so
    // a field added to the type and not to the reader is stored and then lost on
    // the way back. This one is the difference between a metadata-document
    // client surviving a move to another authorization server and being refused
    // as belonging to the old one.
    const connection: McpConnection = {
      agentName: "p",
      serverName: "slack",
      clientId: "https://studio.example.com/api/mcps/oauth/client-metadata/p",
      clientFromMetadataDocument: true,
      issuer: "https://auth.example.com",
      resource: "https://mcp.slack.com",
      scopes: ["chat:write"],
      status: "connected",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await mcpConnectionRepository.put(connection);
    const read = await mcpConnectionRepository.get("p", "slack");

    expect(read?.clientFromMetadataDocument).toBe(true);
    expect(read?.clientId).toBe(connection.clientId);
    expect(read?.issuer).toBe(connection.issuer);
  });

  it("survives the round trip for a dynamically registered client too", async () => {
    // The other exemption on the same axis, and the same failure mode: lost on
    // the way back, a registered client cannot be re-registered when its entry
    // moves, so the owner is told to go and register an app by hand for
    // credentials this app issued itself.
    await mcpConnectionRepository.put({
      agentName: "p",
      serverName: "slack",
      clientId: "dcr-1",
      clientSecret: "enc:s",
      clientRegistered: true,
      issuer: "https://auth.example.com",
      resource: "https://mcp.slack.com",
      scopes: [],
      status: "needs_auth",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await mcpConnectionRepository.get("p", "slack"))?.clientRegistered).toBe(true);
  });

  it("round-trips the auth method the registration recorded", async () => {
    // Written by the registration branch, read by the callback and the refresh;
    // lost on the way back, every exchange fell to the entry's discovered
    // method and the server that enforces its recorded one answered
    // invalid_client on each.
    await mcpConnectionRepository.put({
      agentName: "p",
      serverName: "slack",
      clientId: "dcr-1",
      clientSecret: "enc:s",
      clientRegistered: true,
      tokenEndpointAuthMethod: "client_secret_basic",
      issuer: "https://auth.example.com",
      resource: "https://mcp.slack.com",
      scopes: [],
      status: "needs_auth",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await mcpConnectionRepository.get("p", "slack"))?.tokenEndpointAuthMethod).toBe("client_secret_basic");
  });

  it("leaves both flags absent for a client the owner entered", async () => {
    await mcpConnectionRepository.put({
      agentName: "p",
      serverName: "slack",
      clientId: "typed-by-hand",
      issuer: "https://auth.example.com",
      resource: "https://mcp.slack.com",
      scopes: [],
      status: "needs_auth",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const read = await mcpConnectionRepository.get("p", "slack");
    expect(read?.clientFromMetadataDocument).toBeUndefined();
    expect(read?.clientRegistered).toBeUndefined();
  });
});

describe("connections written before the checks existed", () => {
  it("lets the owner replace an unreadable legacy grant", async () => {
    store.seed([{
      ...keys.mcpConnection("p", "slack"), agentName: "p", serverName: "slack",
      clientId: "old", status: "connected", updatedAt: "2026-01-01T00:00:00.000Z",
    }]);
    expect(await mcpConnectionRepository.get("p", "slack")).toBeNull();

    const replacement: McpConnection = {
      agentName: "p", serverName: "slack", clientId: "new",
      issuer: "https://auth.example.com", resource: "https://mcp.example.com",
      scopes: [], status: "needs_auth", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await mcpConnectionRepository.putIfCurrent(replacement, null)).toBe(true);
    expect((await mcpConnectionRepository.get("p", "slack"))?.clientId).toBe("new");
  });

  it("fills a bounded page past unusable legacy rows", async () => {
    const valid = (serverName: string): McpConnection => ({
      agentName: "p",
      serverName,
      clientId: "client",
      issuer: `https://${serverName}.example.com`,
      resource: `https://${serverName}.example.com`,
      scopes: [],
      status: "needs_auth",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await mcpConnectionRepository.put(valid("a"));
    store.seed([
      {
        ...keys.mcpConnection("p", "b"),
        agentName: "p",
        serverName: "b",
        clientId: "old",
        status: "connected",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await mcpConnectionRepository.put(valid("c"));

    const listed = await mcpConnectionRepository.listByAgent("p", 2);

    expect(listed.map((connection) => connection.serverName)).toEqual(["a", "c"]);
  });

  it("reads a row missing its issuer as no connection at all", async () => {
    // There is nothing safe to assume for it. The old fallback — "it belongs to
    // whatever the entry points at now" — is the assumption the field exists to
    // stop making, and a token checked against a guess is not checked.
    store.seed([
      {
        ...keys.mcpConnection("p", "slack"),
        agentName: "p",
        serverName: "slack",
        clientId: "old",
        resource: "https://mcp.slack.com",
        scopes: [],
        status: "connected",
        accessToken: "enc:token",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(await mcpConnectionRepository.get("p", "slack")).toBeNull();
  });

  it("reads a row missing its resource the same way", async () => {
    store.seed([
      {
        ...keys.mcpConnection("p", "slack"),
        agentName: "p",
        serverName: "slack",
        clientId: "old",
        issuer: "https://auth.example.com",
        scopes: [],
        status: "connected",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(await mcpConnectionRepository.get("p", "slack")).toBeNull();
  });
});
