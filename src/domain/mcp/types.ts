/** A tool a bound MCP server offers. `inputSchema` is the JSON Schema the
 * server advertises; absent when it declares none. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** How a token-endpoint request proves which client it is. From AS metadata. */
export type TokenEndpointAuthMethod = "client_secret_post" | "client_secret_basic" | "none";

/**
 * What one registry entry needs to run an OAuth flow against its server,
 * discovered once at registration (RFC 9728 → RFC 8414) and stored.
 *
 * Discovery is NOT repeated at dispatch: it would put two extra round trips on
 * every time-to-first-token and a third-party outage on the critical path. The
 * values here belong to the server, never to a caller — whose credentials they
 * are is the connection's business.
 */
export interface McpServerAuth {
  type: "oauth2";
  /**
   * The RFC 9728 canonical URI of this MCP server, sent as the RFC 8707
   * `resource` parameter on every authorization and token request. Read off the
   * metadata's own `resource` field, never derived from the endpoint URL: they
   * differ in practice (Slack serves `…/mcp` but identifies as the origin).
   */
  resource: string;
  /** Which `authorization_servers` entry was chosen; the choice is the client's. */
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7591. Absent means the provider requires a manually registered app. */
  registrationEndpoint?: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  scopesSupported?: string[];
  discoveredAt: string;
}

export interface McpServer {
  name: string;
  url: string;
  /** Present when the server requires OAuth; absent for static-header servers. */
  auth?: McpServerAuth;
  /**
   * One-line summary. This is the only field the engine shows the model — it
   * becomes a row in the system prompt's "Connected MCP Servers" table
   * (`mcpSystemPromptAddition`), so it must stay single-line or the markdown
   * table breaks.
   */
  description?: string;
  /**
   * Operator notes in markdown (setup steps, caveats, links). Console-only:
   * never sent to the model, unlike a skill's content.
   */
  content?: string;
  /** Values encrypted at rest (enc:v1: prefix); masked on client reads (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4). */
  headers: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
