import { mcpAccountProvider, readMcpConnectedAccount, type McpAccountClient } from "@/domain/mcp/account";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";

const ACCOUNT_TIMEOUT_MS = 5_000;
const MAX_ACCOUNT_RESPONSE_BYTES = 32_000;

export const mcpAccountClient: McpAccountClient = {
  async read(auth, accessToken) {
    const provider = mcpAccountProvider(auth);
    if (!provider) return { status: "unsupported" };
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
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "unavailable" };
    const record = body as Record<string, unknown>;
    const label = provider === "github" ? record.login : record.email;
    const account = readMcpConnectedAccount({ provider, label });
    return account ? { status: "resolved", account } : { status: "unavailable" };
  },
};
