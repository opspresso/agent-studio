import { resolveMcpAccountLookup, accountLabelAt, isMcpAccountEndpoint, readMcpConnectedAccount, type McpAccountClient, type ResolvedMcpAccountLookup, type McpAccountResult } from "@/domain/mcp/account";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";
import { McpSession } from "./session";

const ACCOUNT_TIMEOUT_MS = 5_000;
const MAX_ACCOUNT_RESPONSE_BYTES = 32_000;

function verifiedDisplayAccount(resolved: ResolvedMcpAccountLookup, body: unknown, accessToken: string) {
  const account = readMcpConnectedAccount({ provider: resolved.provider, label: userLabel(resolved, body) });
  // An identity response must never turn this credential into a reveal path.
  return account && !account.label.includes(accessToken) ? account : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Current-user MCP tools return structured content or one JSON text block. */
function mcpAccountBody(value: unknown): unknown {
  const result = record(value);
  if (!result || result.isError === true || result.resultType === "input_required") return undefined;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ACCOUNT_RESPONSE_BYTES) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content.filter(part => record(part)?.type === "text");
  if (text.length !== 1) return undefined;
  const body = record(text[0])?.text;
  if (typeof body !== "string") return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

function userLabel(resolved: ResolvedMcpAccountLookup, body: unknown): unknown {
  const data = record(body);
  if (resolved.oidc) {
    if (typeof data?.sub !== "string" || !data.sub) return undefined;
    return [data.email, data.preferred_username, data.name, data.sub].find(value => typeof value === "string" && value.trim());
  }
  if (resolved.provider === "github") return data?.login;
  if (resolved.provider === "notion") {
    // Only the self query's single result identifies the grant holder. A general
    // workspace user list must never supply an arbitrary first member's identity.
    if (!Array.isArray(data?.results) || data.results.length !== 1 || data.has_more === true) return undefined;
    const user = record(data.results[0]);
    return user?.email || user?.name;
  }
  if (resolved.provider === "plaud") return data?.email || data?.nickname;
  return accountLabelAt(body, resolved.lookup.labelPath);
}

async function readMcpAccount(
  resolved: ResolvedMcpAccountLookup,
  endpoint: string,
  accessToken: string,
  loopback?: boolean,
): Promise<McpAccountResult> {
  if (resolved.lookup.kind !== "mcp") return { status: "unsupported" };
  const lookup = resolved.lookup;
  const session = new McpSession(endpoint, { Authorization: `Bearer ${accessToken}` }, AbortSignal.timeout(ACCOUNT_TIMEOUT_MS), loopback);
  try {
    const { tools } = await session.listTools();
    const tool = tools.find(tool => tool.name === lookup.toolName);
    if (!tool) return { status: "unsupported" };
    if (tool.annotations?.readOnlyHint === false || (resolved.requireReadOnly && tool.annotations?.readOnlyHint !== true)) return { status: "unsupported" };
    const result = await session.callTool(tool.name, lookup.arguments, tool);
    const body = mcpAccountBody(result);
    const account = verifiedDisplayAccount(resolved, body, accessToken);
    return account ? { status: "resolved", account } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    await session.end();
  }
}

export const mcpAccountClient: McpAccountClient = {
  async read(auth, accessToken, context) {
    const resolved = resolveMcpAccountLookup(auth);
    if (!resolved) return { status: auth.accountLookup?.kind === "none" ? "disabled" : "not_configured" };
    if (!accessToken.trim()) return { status: "unavailable" };
    // These OAuth tokens are scoped to MCP. Their identity comes from the
    // provider's self tool at that resource, not from its separate REST API.
    if (resolved.lookup.kind === "mcp") {
      const endpoint = context?.mcpUrl ?? (resolved.provider === "notion" || resolved.provider === "plaud" ? auth.resource : undefined);
      return endpoint ? readMcpAccount(resolved, endpoint, accessToken, context?.loopback) : { status: "unsupported" };
    }
    const endpoint = resolved.lookup.endpoint;
    if (!isMcpAccountEndpoint(endpoint)) return { status: "unavailable" };
    let body: unknown;
    try {
      const response = await fetchPublicUrl(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: resolved.provider === "github" ? "application/vnd.github+json" : "application/json",
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
    const account = verifiedDisplayAccount(resolved, body, accessToken);
    return account ? { status: "resolved", account } : { status: "unavailable" };
  },
};
