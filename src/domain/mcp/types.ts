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

/**
 * How a server is reached, and therefore why its address may be trusted.
 *
 * `remote` is every entry that has ever existed: an operator typed a URL, and
 * it earns trust by passing the SSRF guard at registration and again at
 * dispatch. Absent means `remote`, so stored rows keep their meaning.
 *
 * `managed` is a container this app started on its own host. Its address is
 * loopback — which the guard rejects, correctly, for anything an operator
 * types — so trust comes from provenance instead: nobody named the address, we
 * recorded it after binding the port.
 */
export type McpRuntime = "remote" | "managed";

/**
 * The one place that decides an entry may skip the public-URL guard.
 *
 * Deliberately narrow. Not "managed servers are trusted" and not "private
 * addresses are allowed for managed servers", but: this entry says it is
 * managed, and the address we recorded for it is loopback. A managed entry
 * carrying anything else is a bug or tampering, and is refused like any other
 * private address would be.
 */
export function isManagedLoopback(server: Pick<McpServer, "runtime" | "url">): boolean {
  if (server.runtime !== "managed") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(server.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  // Literal addresses only: a hostname would have to be resolved, and whatever
  // it resolves to could change between the check and the request.
  return parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
}

export interface McpServer {
  name: string;
  url: string;
  /** Absent on every row written before managed servers existed: those are `remote`. */
  runtime?: McpRuntime;
  /**
   * Managed only: the image the provisioner runs. An image reference, never a
   * command — an operator who can edit this entry must not thereby be able to
   * run arbitrary code on the host.
   */
  image?: string;
  /**
   * Managed only: names of SSM parameters holding the container's environment.
   * References, not values: the secrets never enter this table.
   */
  envRefs?: string[];
  /**
   * Managed only: the port the container listens on inside itself. Stored so a
   * restart can rebuild the spec the entry was created from — an operator types
   * this once, and nothing else remembers it. Absent on rows written before it
   * was persisted; the provisioner falls back to the port it binds anyway.
   */
  containerPort?: number;
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
