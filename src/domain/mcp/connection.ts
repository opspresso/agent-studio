/**
 * One project's OAuth connection to a shared registry MCP server, and the
 * short-lived record of an authorization still in flight.
 *
 * The registry entry is shared and says *where* the authorization server is
 * (`McpServerAuth`); a connection is per project and says *who is asking*. That
 * split is what lets one `mcp.slack.com` entry serve a different Slack app per
 * project.
 *
 * Why its own item rather than the version's `McpBinding` or the project item:
 * a version is a snapshot of configuration history while an access token turns
 * over on the provider's schedule, and the project item's `updatedAt` guards
 * publish/update with optimistic concurrency — refreshing a token there would
 * make refreshes and publishes fight.
 */

/** Where a connection is in its lifecycle; drives what the console offers. */
export type McpConnectionStatus = "needs_auth" | "connected" | "needs_reauth";

export interface McpConnection {
  projectName: string;
  serverName: string;
  /** Not a secret; stored in the clear. Issued by RFC 7591 or entered by hand. */
  clientId: string;
  /** Encrypted. Absent for a public client (`token_endpoint_auth_method: "none"`). */
  clientSecret?: string;
  /** True when RFC 7591 issued the credentials, so they can be re-registered. */
  clientRegistered?: boolean;
  scopes: string[];
  /** Encrypted. */
  accessToken?: string;
  /** Encrypted. Absent when the provider issues no refresh token. */
  refreshToken?: string;
  /** ISO. Absent means the access token does not expire. */
  expiresAt?: string;
  status: McpConnectionStatus;
  /** Email of the owner who completed the authorization. */
  connectedBy?: string;
  connectedAt?: string;
  updatedAt: string;
}

/**
 * An authorization the user has been sent off to complete. Holds the PKCE
 * verifier that proves the callback belongs to the request that started it, and
 * the identity the callback must match.
 *
 * Written with a TTL and consumed exactly once: a replayed `state` must not be
 * able to bind a second token, and an abandoned one must not linger.
 */
export interface McpOAuthState {
  state: string;
  projectName: string;
  serverName: string;
  /** Encrypted — it is the secret half of the PKCE pair. */
  codeVerifier: string;
  /** The user who started the flow; the callback must be the same person. */
  userEmail: string;
  createdAt: string;
}

export interface McpConnectionRepository {
  get(projectName: string, serverName: string): Promise<McpConnection | null>;
  listByProject(projectName: string): Promise<McpConnection[]>;
  put(connection: McpConnection): Promise<void>;
  /**
   * Replace the tokens only if the stored refresh token is still the one the
   * caller refreshed from.
   *
   * Providers that rotate refresh tokens revoke the previous one, so two
   * instances refreshing at once means the loser's write would store a token the
   * provider has already invalidated — and the connection would be dead until
   * someone re-authorized. Returns false when the condition failed, which means
   * another instance already stored a newer token and the caller should re-read
   * rather than treat it as an error.
   *
   * `expectedRefreshToken` is the **stored** value, passed back exactly as it was
   * read. Encryption is randomized, so re-encrypting the same plaintext produces
   * a different ciphertext and would never match — which makes this a comparison
   * on "has the row changed since I read it", the thing a compare-and-set
   * actually needs to know.
   */
  updateTokens(
    projectName: string,
    serverName: string,
    expectedRefreshToken: string | undefined,
    next: Pick<
      McpConnection,
      "accessToken" | "refreshToken" | "expiresAt" | "status" | "updatedAt"
    >,
  ): Promise<boolean>;
  delete(projectName: string, serverName: string): Promise<void>;
}

export interface McpOAuthStateRepository {
  put(state: McpOAuthState, ttlSeconds: number): Promise<void>;
  /**
   * Read and delete in one step. Returns null when the state never existed, has
   * expired, or was already consumed — the caller cannot tell those apart, and
   * must not: each is a request that has no business completing.
   */
  consume(state: string): Promise<McpOAuthState | null>;
}
