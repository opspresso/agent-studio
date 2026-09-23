/**
 * Discovering what an OAuth flow against a registry MCP server needs.
 *
 * The failure this guards against is a build shaped around one provider: Slack
 * has no dynamic registration, one authorization server and `client_secret_post`,
 * so code written against Slack alone silently assumes all three.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The SSRF boundary has its own tests and resolves DNS for real; here it stands
// aside so the stubbed fetch is what the metadata client talks to.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { ConflictError, ValidationError } from "@/application/errors";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import type { McpServer, McpServerAuth } from "@/domain/mcp/types";
import type { OAuthMetadataClient } from "@/domain/mcp/oauth";
import { McpMetadataError } from "@/domain/mcp/oauth";
import type { McpRepository } from "@/domain/mcp/repository";
import { mcpRepository } from "@/infrastructure/db/repositories/mcpRepository";
import type { FakeStore } from "./fakeStore";

const store = await import("@/infrastructure/db/store") as unknown as FakeStore;

const SERVER: McpServer = {
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  headers: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function useCases(
  metadata: Partial<OAuthMetadataClient>,
  opts: {
    blocked?: string[];
    server?: McpServer;
    internalHostSuffixes?: string[];
    allowUnadvertisedPkce?: boolean;
    repository?: McpRepository;
    lifecycleClaims?: Set<string>;
  } = {},
) {
  let server = opts.server ?? SERVER;
  const stored: McpServer[] = [];
  const deps = {
    serviceName: "Agent Studio",
    lifecycleClaims: opts.lifecycleClaims ?? new Set<string>(),
    mcps: opts.repository ?? {
      get: async (name: string) => (name === server.name ? { ...server } : null),
      put: async (saved: McpServer) => {
        stored.push(saved);
      },
      updateAuth: async (name: string, expectedUrl: string, auth: McpServerAuth | undefined, updatedAt: string) => {
        if (server.name !== name || server.url !== expectedUrl) {
          return false;
        }
        const { auth: _previous, ...current } = server;
        void _previous;
        server = { ...current, ...(auth ? { auth } : {}), updatedAt };
        stored.push(server);
        return true;
      },
    } as never,
    metadata: {
      fetchProtectedResource: async () => {
        throw new Error("not stubbed");
      },
      fetchAuthorizationServer: async () => {
        throw new Error("not stubbed");
      },
      ...metadata,
    } as OAuthMetadataClient,
    urlPolicy: {
      assertAllowed: async (url: string) => {
        if ((opts.blocked ?? []).some((blocked) => url.startsWith(blocked))) {
          throw new BlockedUrlError("blocked host");
        }
      },
    },
    // Discovery is an admin action on the shared entry; none of the per-project
    // collaborators below are reachable from it.
    projects: {} as never,
    connections: {} as never,
    states: {} as never,
    oauth: {} as never,
    cipher: {} as never,
    probe: {} as never,
    authProvider: {} as never,
    publicBaseUrl: async () => undefined,
    ...(opts.internalHostSuffixes ? { internalHostSuffixes: opts.internalHostSuffixes } : {}),
    // The fixtures above predate the spec's refusal and say nothing about PKCE;
    // the default here accepts them, and the refusal has its own tests below.
    allowUnadvertisedPkce: opts.allowUnadvertisedPkce ?? true,
  };
  return { useCases: createMcpAuthUseCases(deps), stored };
}

/** Slack: no registration endpoint, one AS, `client_secret_post`. */
const SLACK_RESOURCE = {
  resource: "https://mcp.slack.com",
  authorizationServers: ["https://mcp.slack.com"],
  scopesSupported: ["chat:write", "users:read"],
};
const SLACK_AS = {
  issuer: "https://mcp.slack.com",
  authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
  tokenEndpointAuthMethodsSupported: ["client_secret_post"],
  codeChallengeMethodsSupported: ["S256"],
  grantTypesSupported: ["authorization_code", "refresh_token"],
};

describe("discovering a server's authorization configuration", () => {
  it.each(["discover", "clearAuth"] as const)("does not %s across a managed lifecycle write", async (operation) => {
    const claims = new Set([SERVER.name]);
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => SLACK_AS,
    }, { lifecycleClaims: claims });
    await expect(uc[operation](SERVER.name)).rejects.toBeInstanceOf(ConflictError);
    expect(stored).toEqual([]);
    expect(claims.has(SERVER.name)).toBe(true);
    claims.clear();
    await uc[operation](SERVER.name);
    expect(stored).toHaveLength(1);
    expect(claims.size).toBe(0);
  });

  it("stores what Slack publishes, taking `resource` from the metadata not the URL", async () => {
    // Slack serves `…/mcp` but identifies as its origin. Deriving the resource
    // from the endpoint would send an audience the server never claims, and a
    // server that validates audience would reject every token we obtained.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => SLACK_AS,
    });

    const result = await uc.discover("slack");

    expect(result.status).toBe("discovered");
    expect(stored[0]?.auth).toMatchObject({
      type: "oauth2",
      resource: "https://mcp.slack.com",
      authorizationServer: "https://mcp.slack.com",
      authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
      tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(stored[0]?.auth?.registrationEndpoint).toBeUndefined();
  });

  it("records a registration endpoint and a public client when the server offers them", async () => {
    // The shape most hosted MCP servers use: register dynamically, no secret.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => ({
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth.example.com"],
      }),
      fetchAuthorizationServer: async () => ({
        issuer: "https://auth.example.com",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: "https://auth.example.com/register",
        tokenEndpointAuthMethodsSupported: ["none"],
      }),
    });

    await uc.discover("slack");

    expect(stored[0]?.auth).toMatchObject({
      registrationEndpoint: "https://auth.example.com/register",
      tokenEndpointAuthMethod: "none",
    });
  });

  it("asks which authorization server to use rather than taking the first", async () => {
    // RFC 9728 puts the choice on the client. Silently taking [0] would bind
    // every project's tokens to whichever the provider happened to list first.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => ({
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth-a.example.com", "https://auth-b.example.com"],
      }),
    });

    const result = await uc.discover("slack");

    expect(result).toEqual({
      status: "choose",
      resource: "https://mcp.example.com",
      authorizationServers: ["https://auth-a.example.com", "https://auth-b.example.com"],
    });
    expect(stored).toHaveLength(0);
  });

  it("accepts a chosen authorization server only from the advertised list", async () => {
    const metadata = {
      fetchProtectedResource: async () => ({
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth-a.example.com", "https://auth-b.example.com"],
      }),
      fetchAuthorizationServer: async (issuer: string) => ({
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
      }),
    };
    const { useCases: uc, stored } = useCases(metadata);

    await uc.discover("slack", { authorizationServer: "https://auth-b.example.com" });
    expect(stored[0]?.auth?.authorizationServer).toBe("https://auth-b.example.com");

    // Anything else would point this server's tokens at an authorization server
    // the resource never vouched for.
    await expect(
      useCases(metadata).useCases.discover("slack", {
        authorizationServer: "https://attacker.example.com",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a discovered endpoint the URL policy blocks, and stores nothing", async () => {
    // The documents are third-party input; one naming an internal address is
    // exactly the SSRF the guard exists for.
    const { useCases: uc, stored } = useCases(
      {
        fetchProtectedResource: async () => ({
          resource: "https://mcp.example.com",
          authorizationServers: ["https://auth.example.com"],
        }),
        fetchAuthorizationServer: async () => ({
          issuer: "https://auth.example.com",
          authorizationEndpoint: "https://auth.example.com/authorize",
          tokenEndpoint: "https://169.254.169.254/token",
        }),
      },
      { blocked: ["https://169.254.169.254"] },
    );

    await expect(uc.discover("slack")).rejects.toThrow(ValidationError);
    expect(stored).toHaveLength(0);
  });

  it("refuses a non-https endpoint even where the URL policy would allow it", async () => {
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => ({
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth.example.com"],
      }),
      fetchAuthorizationServer: async () => ({
        issuer: "https://auth.example.com",
        authorizationEndpoint: "http://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
      }),
    });

    await expect(uc.discover("slack")).rejects.toThrow(/must be https/);
  });

  it("refuses a server that states PKCE support without S256", async () => {
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => ({ ...SLACK_AS, codeChallengeMethodsSupported: ["plain"] }),
    });

    await expect(uc.discover("slack")).rejects.toThrow(/S256/);
  });

  it("defaults to client_secret_basic when the server states no method", async () => {
    // RFC 8414's own default; assuming `post` would break Basic-only servers.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => ({
        issuer: "https://mcp.slack.com",
        authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
        tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
      }),
    });

    await uc.discover("slack");
    expect(stored[0]?.auth?.tokenEndpointAuthMethod).toBe("client_secret_basic");
  });

  it("stores the issuer the server publishes, not the URL it was asked at", async () => {
    // RFC 9207 compares a callback's `iss` against this value, so it has to be
    // the server's own claim. The two are equal for a conforming server, which
    // is exactly why taking the wrong one would go unnoticed until they differ.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => ({
        resource: "https://mcp.example.com",
        authorizationServers: ["https://auth.example.com/tenant-a"],
      }),
      fetchAuthorizationServer: async () => ({
        issuer: "https://auth.example.com/issuer/tenant-a",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        issParameterSupported: true,
      }),
    });

    await uc.discover("slack");

    expect(stored[0]?.auth?.authorizationServer).toBe("https://auth.example.com/tenant-a");
    expect(stored[0]?.auth?.issuer).toBe("https://auth.example.com/issuer/tenant-a");
    expect(stored[0]?.auth?.issParameterSupported).toBe(true);
  });

  it("leaves the iss advertisement off unless the server states it", async () => {
    // It decides only whether a *missing* `iss` is fatal, so assuming it would
    // break every server that simply does not implement RFC 9207.
    const { useCases: uc, stored } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => SLACK_AS,
    });

    await uc.discover("slack");

    expect(stored[0]?.auth?.issParameterSupported).toBeUndefined();
  });

  it("clears the block, returning the entry to static-header behaviour", async () => {
    const { useCases: uc, stored } = useCases({});
    await uc.clearAuth("slack");
    expect(stored[0]).toBeDefined();
    expect("auth" in (stored[0] as object)).toBe(false);
  });
});

describe("OAuth metadata writes racing registry edits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SERVER.updatedAt));
    store.rows.clear();
  });
  afterEach(() => vi.useRealTimers());

  async function pendingDiscovery() {
    await mcpRepository.put(SERVER);
    const started = Promise.withResolvers<void>();
    const metadata = Promise.withResolvers<typeof SLACK_AS>();
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => {
        started.resolve();
        return metadata.promise;
      },
    }, { repository: mcpRepository });
    const result = uc.discover(SERVER.name);
    await started.promise;
    return { result, metadata };
  }

  it.each(["deleted", "moved"])("refuses discovery after the original entry was %s", async (change) => {
    const pending = await pendingDiscovery();
    if (change === "deleted") {
      await mcpRepository.delete(SERVER.name);
    } else {
      await mcpRepository.put({ ...SERVER, url: "https://other.example/mcp" });
    }
    pending.metadata.resolve(SLACK_AS);

    await expect(pending.result).rejects.toBeInstanceOf(ConflictError);
    const current = await mcpRepository.get(SERVER.name);
    if (change === "deleted") {
      expect(current).toBeNull();
    } else {
      expect(current?.url).toBe("https://other.example/mcp");
      expect(current?.auth).toBeUndefined();
    }
  });

  it("adds discovered auth without undoing concurrent headers and description edits", async () => {
    const pending = await pendingDiscovery();
    const edited = { ...SERVER, headers: { Authorization: "enc:new-header" }, description: "edited" };
    await mcpRepository.put(edited);
    pending.metadata.resolve(SLACK_AS);

    await expect(pending.result).resolves.toMatchObject({ status: "discovered" });
    expect(await mcpRepository.get(SERVER.name)).toMatchObject({
      ...edited,
      auth: { issuer: SLACK_AS.issuer, resource: SLACK_RESOURCE.resource },
    });
  });

  it.each(["deleted", "moved", "edited"])("clears auth safely when the entry was %s after reading", async (change) => {
    const { result, metadata } = await pendingDiscovery();
    metadata.resolve(SLACK_AS);
    await result;
    const original = await mcpRepository.get(SERVER.name);
    expect(original?.auth).toBeDefined();
    const read = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { useCases: uc } = useCases({}, { repository: {
      ...mcpRepository,
      async get(name) {
        const snapshot = await mcpRepository.get(name);
        read.resolve();
        await resume.promise;
        return snapshot;
      },
    } });
    const clearing = uc.clearAuth(SERVER.name);
    await read.promise;
    const edited = {
      ...original!,
      ...(change === "moved" ? { url: "https://other.example/mcp" } : {}),
      headers: { Authorization: "enc:new-header" },
      description: "edited",
    };
    if (change === "deleted") {
      await mcpRepository.delete(SERVER.name);
    } else {
      await mcpRepository.put(edited);
    }
    resume.resolve();

    if (change === "edited") {
      await expect(clearing).resolves.toBeUndefined();
      expect(await mcpRepository.get(SERVER.name)).toMatchObject({ ...edited, auth: undefined });
    } else {
      await expect(clearing).rejects.toBeInstanceOf(ConflictError);
      expect(await mcpRepository.get(SERVER.name)).toEqual(change === "deleted" ? null : edited);
    }
  });
});

describe("well-known URL candidates", () => {
  it("tries the path-inserted form before the origin form", async () => {
    // A host serving several MCP endpoints distinguishes them by path; taking
    // the origin form first would read another endpoint's document.
    const { wellKnownCandidates } = await import("@/infrastructure/mcp/oauthMetadata");
    expect(wellKnownCandidates("https://mcp.example.com/tenant-a/mcp", "oauth-protected-resource"))
      .toEqual([
        "https://mcp.example.com/.well-known/oauth-protected-resource/tenant-a/mcp",
        "https://mcp.example.com/.well-known/oauth-protected-resource",
      ]);
  });

  it("offers only the origin form when there is no path", async () => {
    const { wellKnownCandidates } = await import("@/infrastructure/mcp/oauthMetadata");
    expect(wellKnownCandidates("https://mcp.example.com/", "oauth-authorization-server")).toEqual([
      "https://mcp.example.com/.well-known/oauth-authorization-server",
    ]);
  });
});

describe("reading a metadata document", () => {
  it("falls through to the next candidate when one returns a non-JSON 200", async () => {
    // A login page served with a 200 is not metadata. Failing there would make
    // discovery depend on which candidate a proxy happens to intercept.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        // Matched on the path, not the whole URL: the host itself starts with
        // `mcp.`, so a substring check would treat both candidates the same.
        return new URL(String(url)).pathname.endsWith("/mcp")
          ? new Response("<!DOCTYPE html>", { headers: { "Content-Type": "text/html" } })
          : new Response(
              JSON.stringify({
                resource: "https://mcp.example.com",
                authorization_servers: ["https://auth.example.com"],
              }),
              { headers: { "Content-Type": "application/json" } },
            );
      }),
    );
    const { oauthMetadataClient } = await import("@/infrastructure/mcp/oauthMetadata");

    const result = await oauthMetadataClient.fetchProtectedResource("https://mcp.example.com/mcp");

    expect(result.resource).toBe("https://mcp.example.com");
    // Probe for an authoritative challenge, then the two well-known forms.
    expect(calls).toHaveLength(3);
    vi.unstubAllGlobals();
  });

  it("reads the RFC 9207 advertisement only from an explicit boolean true", async () => {
    // The field decides whether a response *without* `iss` is refused. A string
    // "true", or any other truthy shape, would switch that refusal on for a
    // server that never promised anything — and break every one of its flows.
    for (const [advertised, expected] of [
      [true, true],
      ["true", undefined],
      [false, undefined],
      [undefined, undefined],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                issuer: "https://auth.example.com",
                authorization_endpoint: "https://auth.example.com/authorize",
                token_endpoint: "https://auth.example.com/token",
                ...(advertised === undefined
                  ? {}
                  : { authorization_response_iss_parameter_supported: advertised }),
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
      );
      const { oauthMetadataClient } = await import("@/infrastructure/mcp/oauthMetadata");

      const metadata = await oauthMetadataClient.fetchAuthorizationServer(
        "https://auth.example.com",
      );

      expect(metadata.issParameterSupported).toBe(expected);
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Discovery is the third caller that has to decide whether an address may skip
 * the outbound guard, and it was the one that answered for itself. Registration
 * and dispatch both ask `skipsUrlGuard`; this reached for `fetchPublicUrl`
 * directly, so an internal Service could be registered and called by a run and
 * never discovered.
 */
describe("discovering a server on a host this deployment declared internal", () => {
  const INTERNAL: McpServer = {
    name: "memory",
    url: "http://mcp-memory.agent-mcps.svc.cluster.local/mcp",
    headers: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("tells the metadata client the guard is not what makes this address safe", async () => {
    const seen: Array<boolean | undefined> = [];
    const { useCases: uc } = useCases(
      {
        fetchProtectedResource: async (_url: string, loopback?: boolean) => {
          seen.push(loopback);
          return { resource: INTERNAL.url, authorizationServers: ["https://auth.example.com"] };
        },
        fetchAuthorizationServer: async () => SLACK_AS,
      },
      { server: INTERNAL, internalHostSuffixes: ["agent-mcps.svc.cluster.local"] },
    );

    await uc.discover("memory");

    expect(seen).toEqual([true]);
  });

  it("leaves the guard in place when the suffix was never declared", async () => {
    const seen: Array<boolean | undefined> = [];
    const { useCases: uc } = useCases(
      {
        fetchProtectedResource: async (_url: string, loopback?: boolean) => {
          seen.push(loopback);
          return { resource: INTERNAL.url, authorizationServers: ["https://auth.example.com"] };
        },
        fetchAuthorizationServer: async () => SLACK_AS,
      },
      { server: INTERNAL },
    );

    await uc.discover("memory");

    expect(seen).toEqual([false]);
  });
});

describe("a metadata read that fails", () => {
  it("is a bad request about the server, not an internal error about us", async () => {
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => {
        throw new McpMetadataError(
          "Could not read protected resource metadata. Tried https://mcp.slack.com/.well-known/oauth-protected-resource/mcp: no usable protected resource metadata",
        );
      },
    });

    const error = await uc.discover("slack").catch((caught: unknown) => caught);

    // 500 told an admin nothing and put `unhandled error` in the logs for a
    // server that simply does not publish the document.
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(400);
    // The candidates it tried are the whole diagnosis; this endpoint is
    // admin-only, so they belong in the answer.
    expect((error as Error).message).toContain("oauth-protected-resource");
  });

  it("still reports a fault of our own as one", async () => {
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => {
        throw new TypeError("cipher is not a function");
      },
    });

    const error = await uc.discover("slack").catch((caught: unknown) => caught);

    // Remapping everything would bury our own bugs behind a 400 that blames the
    // MCP server for them.
    expect(error).toBeInstanceOf(TypeError);
  });

  it("gives the authorization server's document the same treatment", async () => {
    const { useCases: uc } = useCases({
      fetchProtectedResource: async () => SLACK_RESOURCE,
      fetchAuthorizationServer: async () => {
        throw new McpMetadataError("Could not read authorization server metadata. Tried …");
      },
    });

    const error = await uc.discover("slack").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("PKCE the server did not advertise", () => {
  const { codeChallengeMethodsSupported: _advertised, ...SILENT_AS } = SLACK_AS;

  it("is refused by default, as the spec requires", async () => {
    const { useCases: uc } = useCases(
      {
        fetchProtectedResource: async () => SLACK_RESOURCE,
        fetchAuthorizationServer: async () => SILENT_AS,
      },
      { allowUnadvertisedPkce: false },
    );
    await expect(uc.discover("slack")).rejects.toThrow(/does not advertise PKCE/);
  });

  it("is accepted when the deployment says so", async () => {
    const { useCases: uc, stored } = useCases(
      {
        fetchProtectedResource: async () => SLACK_RESOURCE,
        fetchAuthorizationServer: async () => SILENT_AS,
      },
      { allowUnadvertisedPkce: true },
    );
    await uc.discover("slack");
    expect(stored).toHaveLength(1);
  });
});
