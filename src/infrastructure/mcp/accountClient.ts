import { mcpAccountProvider, readMcpConnectedAccount, type McpAccountClient } from "@/domain/mcp/account";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";
import type { McpAccountResult, McpConnectedAccount } from "@/domain/mcp/account";
import { McpSession } from "./session";

const ACCOUNT_TIMEOUT_MS = 5_000;
const MAX_ACCOUNT_RESPONSE_BYTES = 32_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Current-user MCP tools return structured content or one JSON text block. */
function mcpAccountBody(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  if (!result || result.isError === true || result.resultType === "input_required") return undefined;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ACCOUNT_RESPONSE_BYTES) return undefined;
  if (result.structuredContent !== undefined) return record(result.structuredContent);
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content.filter(part => record(part)?.type === "text");
  if (text.length !== 1) return undefined;
  const body = record(text[0])?.text;
  if (typeof body !== "string") return undefined;
  try { return record(JSON.parse(body)); } catch { return undefined; }
}

function userLabel(provider: McpConnectedAccount["provider"], body: Record<string, unknown>): unknown {
  if (provider === "github") return body.login;
  if (provider === "google") return body.email;
  if (provider === "notion") {
    // Only the self query's single result identifies the grant holder. A general
    // workspace user list must never supply an arbitrary first member's identity.
    if (!Array.isArray(body.results) || body.results.length !== 1 || body.has_more === true) return undefined;
    const user = record(body.results[0]);
    return user?.email || user?.name;
  }
  return body.email || body.nickname;
}

async function readMcpAccount(
  provider: "notion" | "plaud",
  endpoint: string,
  accessToken: string,
): Promise<McpAccountResult> {
  const session = new McpSession(endpoint, { Authorization: `Bearer ${accessToken}` }, AbortSignal.timeout(ACCOUNT_TIMEOUT_MS));
  try {
    const { tools } = await session.listTools();
    const toolName = provider === "notion" ? "notion-get-users" : "get_current_user";
    const tool = tools.find(tool => tool.name === toolName);
    if (!tool) return { status: "unsupported" };
    const result = await session.callTool(tool.name, provider === "notion" ? { user_id: "self" } : {}, tool);
    const body = mcpAccountBody(result);
    const account = body && readMcpConnectedAccount({ provider, label: userLabel(provider, body) });
    return account ? { status: "resolved", account } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    await session.end();
  }
}

export const mcpAccountClient: McpAccountClient = {
  async read(auth, accessToken) {
    const provider = mcpAccountProvider(auth);
    if (!provider) return { status: "unsupported" };
    // These OAuth tokens are scoped to MCP. Their identity comes from the
    // provider's self tool at that resource, not from its separate REST API.
    if (provider === "notion" || provider === "plaud") return readMcpAccount(provider, auth.resource, accessToken);
    // Fixed provider endpoints: metadata cannot redirect a token to an arbitrary identity API.
    const endpoint = provider === "github"
      ? "https://api.github.com/user"
      : "https://openidconnect.googleapis.com/v1/userinfo";
    let body: unknown;
    try {
      const response = await fetchPublicUrl(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: provider === "github" ? "application/vnd.github+json" : "application/json",
        },
        // The shared guard rejects cross-origin redirects before forwarding the grant.
        signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: "unavailable" };
      }
      body = JSON.parse(await readBodyText(response, MAX_ACCOUNT_RESPONSE_BYTES));
    } catch {
      // This optional display lookup reports loss explicitly without discarding the grant
      // or relaying provider/transport text that could contain credentials or PII.
      return { status: "unavailable" };
    }
    const data = record(body);
    const account = data && readMcpConnectedAccount({ provider, label: userLabel(provider, data) });
    return account ? { status: "resolved", account } : { status: "unavailable" };
  },
};
