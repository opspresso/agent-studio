import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerAuth } from "@/domain/mcp/types";
import { mcpAccountScopes } from "@/domain/mcp/account";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

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
const notionAuth: McpServerAuth = {
  ...githubAuth, issuer: "https://mcp.notion.com/", authorizationServer: "https://mcp.notion.com/",
  authorizationEndpoint: "https://mcp.notion.com/authorize", tokenEndpoint: "https://mcp.notion.com/token",
  resource: "https://mcp.notion.com/mcp",
};
const plaudAuth: McpServerAuth = {
  ...githubAuth, issuer: "https://mcp.plaud.ai/", authorizationServer: "https://mcp.plaud.ai/",
  authorizationEndpoint: "https://mcp.plaud.ai/authorize", tokenEndpoint: "https://mcp.plaud.ai/token",
  resource: "https://mcp.plaud.ai/mcp",
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
    { ...notionAuth, resource: "https://attacker.test/mcp" },
    { ...notionAuth, issuer: "https://mcp.notion.com.attacker.test/" },
    { ...plaudAuth, tokenEndpoint: "https://attacker.test/token" },
    { ...plaudAuth, resource: "https://mcp.notion.com/mcp" },
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

interface AccountRpcCall { url: string; headers: Headers; method?: string; params?: Record<string, unknown> }

function stubAccountMcp(provider: "notion" | "plaud", result: Record<string, unknown>, missingTool = false) {
  const calls: AccountRpcCall[] = [];
  const toolName = provider === "notion" ? "notion-get-users" : "get_current_user";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number; method?: string; params?: Record<string, unknown>;
    };
    calls.push({ url: String(input), headers: new Headers(init?.headers), method, params });
    const preamble = protocolPreamble(method, id, init?.method);
    if (preamble) return preamble;
    const response = method === "tools/list"
      ? { tools: conforming(missingTool ? [] : [{ name: toolName }]) }
      : result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: modernResult(method, response) }), {
      headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

describe("provider identity through its MCP resource", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2026-09-30T00:00:00.000Z"); });
  afterEach(() => vi.useRealTimers());

  it.each([
    { provider: "notion" as const, auth: notionAuth, body: { results: [{ id: "current-user", type: "person", name: "Current user", email: "notion@example.test" }], has_more: false }, label: "notion@example.test", name: "notion-get-users", args: { user_id: "self" } },
    { provider: "plaud" as const, auth: plaudAuth, body: { id: "current-user", email: "plaud@example.test", nickname: "Current user" }, label: "plaud@example.test", name: "get_current_user", args: {} },
  ])("uses $provider's actual current-user tool without sending the MCP token to another API", async ({ provider, auth, body, label, name, args }) => {
    const calls = stubAccountMcp(provider, { content: [{ type: "text", text: JSON.stringify(body) }] });
    expect(await mcpAccountClient.read(auth, "mcp-scoped-token")).toEqual({ status: "resolved", account: { provider, label } });
    expect(calls.every(call => call.url === auth.resource)).toBe(true);
    expect(calls.every(call => call.headers.get("Authorization") === "Bearer mcp-scoped-token")).toBe(true);
    expect(calls.filter(call => call.method === "tools/call").map(call => ({ name: call.params?.name, arguments: call.params?.arguments })))
      .toEqual([{ name, arguments: args }]);
  });

  it("accepts Notion's canonical issuer without changing the self query", async () => {
    stubAccountMcp("notion", { structuredContent: { results: [{ email: "self@example.test" }], has_more: false }, content: [] });
    expect(await mcpAccountClient.read({ ...notionAuth, issuer: "https://mcp.notion.com" }, "token")).toEqual({
      status: "resolved", account: { provider: "notion", label: "self@example.test" },
    });
  });

  it("uses the provider's actual name when email is not returned", async () => {
    stubAccountMcp("notion", { content: [{ type: "text", text: JSON.stringify({ results: [{ name: "Current Notion user" }], has_more: false }) }] });
    expect(await mcpAccountClient.read(notionAuth, "token")).toEqual({ status: "resolved", account: { provider: "notion", label: "Current Notion user" } });
  });

  it("does not call an unadvertised current-user tool", async () => {
    const calls = stubAccountMcp("plaud", {}, true);
    expect(await mcpAccountClient.read(plaudAuth, "token")).toEqual({ status: "unsupported" });
    expect(calls.some(call => call.method === "tools/call")).toBe(false);
  });

  it.each([
    { content: [{ type: "text", text: '{"results":[{"email":"first@example.test"},{"email":"second@example.test"}]}' }] },
    { content: [{ type: "text", text: '{"results":[{"email":"first@example.test"}],"has_more":true}' }] },
    { isError: true, content: [{ type: "text", text: '{"results":[{"email":"error@example.test"}]}' }] },
    { content: [{ type: "text", text: "not-json" }] },
    { content: [{ type: "text", text: '{"results":[]}' }] },
  ])("refuses an ambiguous or failed self response instead of selecting another workspace member", async (result) => {
    stubAccountMcp("notion", result);
    expect(await mcpAccountClient.read(notionAuth, "token")).toEqual({ status: "unavailable" });
  });
});
