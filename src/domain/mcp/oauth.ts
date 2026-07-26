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
