/**
 * Ports for the OAuth side of the MCP registry: reading a server's published
 * metadata, and later exchanging/refreshing tokens against it.
 *
 * The MCP authorization spec makes discovery mandatory for clients — endpoint
 * paths are never guessed — so these documents are the only source for where a
 * server's authorization server lives and what it accepts.
 */

/** RFC 9728 protected-resource metadata, narrowed to the fields we act on. */
export interface ProtectedResourceMetadata {
  /**
   * The canonical URI identifying this MCP server. Sent as the RFC 8707
   * `resource` parameter, and NOT interchangeable with the endpoint URL — a
   * server may serve `…/mcp` while identifying as its origin.
   */
  resource: string;
  /** At least one, per spec. Choosing among several is the client's job. */
  authorizationServers: string[];
  scopesSupported?: string[];
}

/** RFC 8414 authorization-server metadata, narrowed the same way. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  tokenEndpointAuthMethodsSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  scopesSupported?: string[];
  grantTypesSupported?: string[];
}

/**
 * Reads the two well-known documents. Implementations must try the
 * path-inserted well-known URI before the origin-level one (RFC 9728 §3,
 * RFC 8414 §3): a server hosting several MCP endpoints distinguishes them by
 * path, and only the origin form would collapse them into one.
 */
export interface OAuthMetadataClient {
  /** @throws when neither candidate URL yields a usable document. */
  fetchProtectedResource(mcpUrl: string): Promise<ProtectedResourceMetadata>;
  /** @throws when neither candidate URL yields a usable document. */
  fetchAuthorizationServer(issuer: string): Promise<AuthorizationServerMetadata>;
}

/** What an RFC 7591 registration hands back. A public client gets no secret. */
export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, as the provider reported it. Absent means non-expiring. */
  expiresInSeconds?: number;
  /** Present when the server narrowed what was asked for. */
  scope?: string;
}

/**
 * A token request the provider refused on its own terms — `invalid_grant` and
 * friends. Distinguished from a transport failure because only this means the
 * grant is gone and the owner has to re-authorize; a 5xx or a dropped
 * connection must never cost someone their connection.
 */
export class OAuthGrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthGrantError";
  }
}

export interface TokenRequestTarget {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** From the server's metadata; a client with no secret always sends `none`. */
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
  /** RFC 8707 — sent on every request, whether or not the server acts on it. */
  resource: string;
}

/**
 * Resolves the outbound `Authorization` for one project's connection to one
 * server, refreshing when the stored token is close enough to expiry that a run
 * could outlive it.
 *
 * A run asks this and nothing else about OAuth: whether a connection exists,
 * whether it needs refreshing and whether refreshing failed are all questions
 * with one answer shape — headers to send, or a reason there are none.
 */
/**
 * The outbound headers this project's OAuth connection contributes, or why it
 * contributes none.
 *
 * `unavailable` is deliberately not called a warning: OAuth is one way to
 * authenticate a registry entry, not the only one, and an entry that carries its
 * own headers still works without a connection. Only the caller knows what else
 * it holds, so only the caller can decide whether this is fatal.
 */
export interface McpAuthResolution {
  headers: Record<string, string>;
  unavailable?: string;
}

export interface McpAuthProvider {
  headersFor(projectName: string, serverName: string): Promise<McpAuthResolution>;
  /**
   * Record that the server rejected this connection's token, so the console can
   * offer a reconnect instead of reporting the server as down.
   */
  markUnauthorized(projectName: string, serverName: string): Promise<void>;
}

export interface OAuthClient {
  /** RFC 7591 dynamic client registration. */
  register(params: {
    registrationEndpoint: string;
    clientName: string;
    redirectUri: string;
    scopes: string[];
  }): Promise<RegisteredClient>;
  /** @throws {OAuthGrantError} when the provider rejects the code itself. */
  exchangeCode(
    target: TokenRequestTarget,
    params: { code: string; redirectUri: string; codeVerifier: string },
  ): Promise<TokenSet>;
  /** @throws {OAuthGrantError} when the refresh token is no longer valid. */
  refresh(target: TokenRequestTarget, refreshToken: string): Promise<TokenSet>;
}
