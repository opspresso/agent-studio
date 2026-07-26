/**
 * Discovering what an OAuth flow against a registry MCP server needs.
 *
 * The failure this guards against is a build shaped around one provider: Slack
 * has no dynamic registration, one authorization server and `client_secret_post`,
 * so code written against Slack alone silently assumes all three.
 */

import { describe, expect, it, vi } from "vitest";

// The SSRF boundary has its own tests and resolves DNS for real; here it stands
// aside so the stubbed fetch is what the metadata client talks to.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { createMcpAuthUseCases } from "@/application/mcp/mcpAuthUseCases";
import { ValidationError } from "@/application/errors";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import type { McpServer } from "@/domain/mcp/types";
import type { OAuthMetadataClient } from "@/domain/mcp/oauth";

const SERVER: McpServer = {
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  headers: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function useCases(metadata: Partial<OAuthMetadataClient>, opts: { blocked?: string[] } = {}) {
  const stored: McpServer[] = [];
  const deps = {
    mcps: {
      get: async (name: string) => (name === SERVER.name ? { ...SERVER } : null),
      put: async (server: McpServer) => {
        stored.push(server);
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
    publicBaseUrl: async () => undefined,
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

  it("clears the block, returning the entry to static-header behaviour", async () => {
    const { useCases: uc, stored } = useCases({});
    await uc.clearAuth("slack");
    expect(stored[0]).toBeDefined();
    expect("auth" in (stored[0] as object)).toBe(false);
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
    expect(calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
