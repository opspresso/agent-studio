import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerAuth } from "@/domain/mcp/types";
import { mcpAccountScopes } from "@/domain/mcp/account";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (url: string, init: RequestInit) => fetch(url, init),
}));
import { mcpAccountClient } from "@/infrastructure/mcp/accountClient";

export const githubAuth: McpServerAuth = {
  type: "oauth2", issuer: "https://github.com/login/oauth",
  authorizationServer: "https://github.com/login/oauth",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  resource: "https://api.githubcopilot.com/mcp/",
  tokenEndpointAuthMethod: "client_secret_post", discoveredAt: "2026-09-30T00:00:00.000Z",
};
export const googleAuth: McpServerAuth = {
  ...githubAuth, issuer: "https://accounts.google.com", authorizationServer: "https://accounts.google.com/",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token", resource: "https://drivemcp.googleapis.com/mcp/v1",
};

beforeEach(() => vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("MCP connected provider account", () => {
  it.each([
    { auth: githubAuth, body: { login: "octocat", email: "studio-user@example.test" }, endpoint: "https://api.github.com/user", account: { provider: "github", label: "octocat" } },
    { auth: googleAuth, body: { sub: "google-subject", email: "connected@example.test" }, endpoint: "https://openidconnect.googleapis.com/v1/userinfo", account: { provider: "google", label: "connected@example.test" } },
  ])("reads the account for the actual grant at $endpoint", async ({ auth, body, endpoint, account }) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetcher);
    expect(await mcpAccountClient.read(auth, "provider-token")).toEqual({ status: "resolved", account });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer provider-token");
    expect(url).not.toContain("provider-token");
  });

  it.each([
    { ...githubAuth, issuer: "https://github.com.attacker.test/login/oauth" },
    { ...githubAuth, tokenEndpoint: "https://attacker.test/token" },
    { ...googleAuth, authorizationEndpoint: "https://attacker.test/authorize" },
    { ...googleAuth, issuer: "https://accounts.google.com.attacker.test" },
  ])("never sends another issuer's token to a known provider", async (auth) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await mcpAccountClient.read(auth, "other-provider-token")).toEqual({ status: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500])("reports an unavailable identity on HTTP %s without exposing provider text", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret-provider-error", { status })));
    expect(await mcpAccountClient.read(googleAuth, "token")).toEqual({ status: "unavailable" });
  });

  it.each(["not-json", "null", '[]', '{}', '{"login":42}', '{"login":""}', '{"login":"bad\\nlabel"}'])(
    "does not invent an account from an unusable response %s", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      expect(await mcpAccountClient.read(githubAuth, "token")).toEqual({ status: "unavailable" });
    },
  );

  it("reports a network failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("token must not be relayed"); }));
    expect(await mcpAccountClient.read(githubAuth, "token")).toEqual({ status: "unavailable" });
  });

  it("requests only the additional scopes needed for Google's email and leaves other providers unchanged", () => {
    expect(mcpAccountScopes(googleAuth, ["drive.file", "email"])).toEqual(["drive.file", "email", "openid"]);
    expect(mcpAccountScopes(githubAuth, ["repo"])).toEqual(["repo"]);
  });
});
