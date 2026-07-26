/**
 * OAuth for registry MCP servers.
 *
 * Discovery runs once, when an admin registers or repairs a server, and stores
 * everything a run needs on the registry entry. The run path never reads a
 * well-known document: that would add two round trips and a third party's
 * availability to every time-to-first-token.
 */

import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer, McpServerAuth, TokenEndpointAuthMethod } from "@/domain/mcp/types";
import type {
  AuthorizationServerMetadata,
  McpAuthProvider,
  OAuthClient,
  OAuthMetadataClient,
  TokenRequestTarget,
} from "@/domain/mcp/oauth";
import type { ListToolsResult, McpToolProbe } from "@/domain/mcp/toolProbe";
import type {
  McpConnection,
  McpConnectionRepository,
  McpOAuthStateRepository,
} from "@/domain/mcp/connection";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { assertProjectOwner } from "@/application/project/projectUseCases";
import { assertAllowedUrl } from "@/application/registry/registryUseCases";
import { createOAuthState, createPkcePair } from "@/shared/pkce";

/**
 * Discovery either finishes, or stops to ask which authorization server to use.
 * RFC 9728 lets a resource advertise several and puts the choice on the client;
 * silently taking the first would bind every project's tokens to whichever the
 * provider happened to list first.
 */
export type DiscoverAuthResult =
  | { status: "discovered"; auth: McpServerAuth }
  | { status: "choose"; resource: string; authorizationServers: string[] };

/**
 * Which client authentication to record. Order is preference, not capability —
 * a connection with no client secret always sends `none` at request time
 * regardless of what is stored here, because it has nothing else to send.
 */
const AUTH_METHOD_PREFERENCE: TokenEndpointAuthMethod[] = [
  "client_secret_basic",
  "client_secret_post",
  "none",
];

function selectAuthMethod(metadata: AuthorizationServerMetadata): TokenEndpointAuthMethod {
  const supported = metadata.tokenEndpointAuthMethodsSupported;
  if (!supported || supported.length === 0) {
    // RFC 8414: the default when the field is omitted.
    return "client_secret_basic";
  }
  const match = AUTH_METHOD_PREFERENCE.find((method) => supported.includes(method));
  if (!match) {
    throw new ValidationError(
      `Authorization server supports none of the client authentication methods this client can use (it offers: ${supported.join(", ")}).`,
    );
  }
  return match;
}

/**
 * Every URL taken from a discovered document is re-validated before it is
 * stored: the documents are third-party input, and one of them naming an
 * internal address is exactly the SSRF the guard exists for. HTTPS is checked
 * separately — the MCP spec requires it for authorization endpoints, and the
 * guard alone would happily allow a public `http:` host.
 */
async function assertAuthEndpoint(policy: UrlPolicy, url: string, label: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError(`${label} must be https (got ${parsed.protocol}//): ${url}`);
  }
  await assertAllowedUrl(policy, url);
}

/** How long a user has to finish an authorization before the state expires. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Where the authorization server sends the browser back. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcps/oauth/callback";

/**
 * A connection as the console may see it.
 *
 * The client secret is masked the way every other stored secret in this codebase
 * is — length-preserving, edges revealed in proportion to length — so an owner
 * can recognise which credential is stored without it being readable. Tokens are
 * absent entirely: unlike the A2A key and the project API token there is no
 * reveal path here, and a token has no reason to be displayed at all.
 */
export interface McpConnectionView {
  serverName: string;
  status: McpConnection["status"];
  clientId: string;
  /** Masked; absent for a public client that has none. */
  clientSecret?: string;
  clientRegistered: boolean;
  scopes: string[];
  connectedBy?: string;
  connectedAt?: string;
  expiresAt?: string;
}

function toConnectionView(cipher: SecretCipher, connection: McpConnection): McpConnectionView {
  return {
    serverName: connection.serverName,
    status: connection.status,
    clientId: connection.clientId,
    ...(connection.clientSecret ? { clientSecret: cipher.mask(connection.clientSecret) } : {}),
    clientRegistered: connection.clientRegistered === true,
    scopes: connection.scopes,
    ...(connection.connectedBy ? { connectedBy: connection.connectedBy } : {}),
    ...(connection.connectedAt ? { connectedAt: connection.connectedAt } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
  };
}

export interface SaveClientCredentialsInput {
  clientId: string;
  /** Omitted for a public client; a masked echo keeps what is stored. */
  clientSecret?: string;
  scopes?: string[];
}

export interface McpAuthUseCasesDeps {
  mcps: McpRepository;
  projects: ProjectRepository;
  connections: McpConnectionRepository;
  states: McpOAuthStateRepository;
  metadata: OAuthMetadataClient;
  oauth: OAuthClient;
  cipher: SecretCipher;
  urlPolicy: UrlPolicy;
  /** One-shot tool listing, shared with the registry's own probe. */
  probe: McpToolProbe;
  /** Resolves (and refreshes) this project's outbound Authorization. */
  authProvider: McpAuthProvider;
  /** Absolute base of this deployment; the redirect URI is built from it. */
  publicBaseUrl: () => Promise<string | undefined>;
}

export interface McpAuthUseCases {
  /**
   * Read the server's published metadata and store what an authorization needs.
   * Pass `authorizationServer` to answer a previous `choose` result.
   */
  discover(name: string, opts?: { authorizationServer?: string }): Promise<DiscoverAuthResult>;
  /** Drop the OAuth block, returning the entry to static-header behaviour. */
  clearAuth(name: string): Promise<void>;

  listConnections(projectName: string, userEmail: string): Promise<McpConnectionView[]>;
  saveClientCredentials(
    projectName: string,
    serverName: string,
    input: SaveClientCredentialsInput,
    userEmail: string,
  ): Promise<McpConnectionView>;
  /** Returns the URL to send the browser to. */
  beginAuthorization(
    projectName: string,
    serverName: string,
    userEmail: string,
  ): Promise<{ authorizeUrl: string }>;
  completeAuthorization(params: {
    state: string;
    code: string;
    userEmail: string;
  }): Promise<{ projectName: string; serverName: string }>;
  disconnect(projectName: string, serverName: string, userEmail: string): Promise<void>;
  /**
   * What this server offers *this project*. The registry's own probe carries
   * only the entry's static headers, so against an OAuth server it can do
   * nothing but 401 — the credential that would answer belongs to the project.
   */
  listTools(projectName: string, serverName: string, userEmail: string): Promise<ListToolsResult>;
}

export function createMcpAuthUseCases(deps: McpAuthUseCasesDeps): McpAuthUseCases {
  async function requireServer(name: string) {
    const server = await deps.mcps.get(name);
    if (!server) {
      throw new NotFoundError(`MCP server not found: ${name}`);
    }
    return server;
  }

  /** A registry entry that actually has an OAuth block to act on. */
  async function requireOAuthServer(name: string): Promise<McpServer & { auth: McpServerAuth }> {
    const server = await requireServer(name);
    if (!server.auth) {
      throw new ValidationError(
        `MCP server "${name}" has no OAuth configuration. An admin must run discovery on it first.`,
      );
    }
    return server as McpServer & { auth: McpServerAuth };
  }

  async function redirectUri(): Promise<string> {
    const base = await deps.publicBaseUrl();
    if (!base) {
      throw new ValidationError(
        "A public base URL must be configured before an OAuth connection can be authorized.",
      );
    }
    // Built here, never from the request: a redirect target taken from caller
    // input is the open-redirect this flow would otherwise hand out.
    return `${base.replace(/\/+$/, "")}${MCP_OAUTH_CALLBACK_PATH}`;
  }

  async function requireConnection(
    projectName: string,
    serverName: string,
  ): Promise<McpConnection> {
    const connection = await deps.connections.get(projectName, serverName);
    if (!connection) {
      throw new NotFoundError(
        `Project "${projectName}" has no connection to MCP server "${serverName}".`,
      );
    }
    return connection;
  }

  return {
    async discover(name, opts) {
      const server = await requireServer(name);
      const resourceMetadata = await deps.metadata.fetchProtectedResource(server.url);

      const choices = resourceMetadata.authorizationServers;
      const requested = opts?.authorizationServer;
      if (!requested && choices.length > 1) {
        return {
          status: "choose",
          resource: resourceMetadata.resource,
          authorizationServers: choices,
        };
      }
      if (requested && !choices.includes(requested)) {
        // The choice has to come from the resource's own list; accepting an
        // arbitrary one would let an admin point this server's tokens at an
        // authorization server the resource never vouched for.
        throw new ValidationError(
          `"${requested}" is not one of the authorization servers this resource advertises (${choices.join(", ")}).`,
        );
      }
      const authorizationServer = requested ?? choices[0];
      if (!authorizationServer) {
        throw new ValidationError("The resource advertises no authorization server.");
      }
      await assertAuthEndpoint(deps.urlPolicy, authorizationServer, "Authorization server");

      const asMetadata = await deps.metadata.fetchAuthorizationServer(authorizationServer);
      await assertAuthEndpoint(
        deps.urlPolicy,
        asMetadata.authorizationEndpoint,
        "Authorization endpoint",
      );
      await assertAuthEndpoint(deps.urlPolicy, asMetadata.tokenEndpoint, "Token endpoint");
      if (asMetadata.registrationEndpoint) {
        await assertAuthEndpoint(
          deps.urlPolicy,
          asMetadata.registrationEndpoint,
          "Registration endpoint",
        );
      }
      // Only when the server states its methods and S256 is absent: many
      // servers support PKCE without advertising it, and refusing those would
      // block working configurations over a missing field.
      const pkce = asMetadata.codeChallengeMethodsSupported;
      if (pkce && !pkce.includes("S256")) {
        throw new ValidationError(
          `Authorization server does not support PKCE S256 (it offers: ${pkce.join(", ")}), which this client requires.`,
        );
      }

      const scopesSupported = resourceMetadata.scopesSupported ?? asMetadata.scopesSupported;
      const auth: McpServerAuth = {
        type: "oauth2",
        resource: resourceMetadata.resource,
        authorizationServer,
        authorizationEndpoint: asMetadata.authorizationEndpoint,
        tokenEndpoint: asMetadata.tokenEndpoint,
        ...(asMetadata.registrationEndpoint
          ? { registrationEndpoint: asMetadata.registrationEndpoint }
          : {}),
        tokenEndpointAuthMethod: selectAuthMethod(asMetadata),
        ...(scopesSupported ? { scopesSupported } : {}),
        discoveredAt: new Date().toISOString(),
      };
      await deps.mcps.put({ ...server, auth, updatedAt: new Date().toISOString() });
      return { status: "discovered", auth };
    },

    async clearAuth(name) {
      const server = await requireServer(name);
      const { auth: _dropped, ...rest } = server;
      await deps.mcps.put({ ...rest, updatedAt: new Date().toISOString() });
    },

    async listConnections(projectName, userEmail) {
      await assertProjectOwner(deps.projects, projectName, userEmail);
      return (await deps.connections.listByProject(projectName)).map((connection) =>
        toConnectionView(deps.cipher, connection),
      );
    },

    async saveClientCredentials(projectName, serverName, input, userEmail) {
      await assertProjectOwner(deps.projects, projectName, userEmail);
      const server = await requireOAuthServer(serverName);
      const existing = await deps.connections.get(projectName, serverName);

      // A masked or empty secret keeps what is stored, matching how every other
      // stored secret in this codebase behaves on update.
      const submitted = input.clientSecret;
      const clientSecret =
        submitted === undefined || submitted === "" || deps.cipher.isMasked(submitted)
          ? existing?.clientSecret
          : deps.cipher.encrypt(submitted);

      const next: McpConnection = {
        projectName,
        serverName,
        clientId: input.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        clientRegistered: false,
        scopes: input.scopes ?? existing?.scopes ?? server.auth.scopesSupported ?? [],
        // Credentials changing invalidates whatever they authorized. Keeping the
        // old tokens would leave a connection that reports `connected` while
        // holding tokens issued to a different client.
        status: "needs_auth",
        updatedAt: new Date().toISOString(),
      };
      await deps.connections.put(next);
      return toConnectionView(deps.cipher, next);
    },

    async beginAuthorization(projectName, serverName, userEmail) {
      await assertProjectOwner(deps.projects, projectName, userEmail);
      const server = await requireOAuthServer(serverName);
      const callback = await redirectUri();
      let connection = await deps.connections.get(projectName, serverName);

      // No client yet: register one if the server offers it, otherwise the owner
      // has to bring credentials from a manually registered app.
      if (!connection?.clientId) {
        if (!server.auth.registrationEndpoint) {
          throw new ValidationError(
            `MCP server "${serverName}" does not support dynamic client registration. Register an app with the provider and save its client ID and secret first.`,
          );
        }
        const scopes = connection?.scopes ?? server.auth.scopesSupported ?? [];
        const registered = await deps.oauth.register({
          registrationEndpoint: server.auth.registrationEndpoint,
          clientName: `Agent Studio — ${projectName}`,
          redirectUri: callback,
          scopes,
        });
        connection = {
          projectName,
          serverName,
          clientId: registered.clientId,
          ...(registered.clientSecret
            ? { clientSecret: deps.cipher.encrypt(registered.clientSecret) }
            : {}),
          clientRegistered: true,
          scopes,
          status: "needs_auth",
          updatedAt: new Date().toISOString(),
        };
        await deps.connections.put(connection);
      }

      const pkce = createPkcePair();
      const state = createOAuthState();
      await deps.states.put(
        {
          state,
          projectName,
          serverName,
          codeVerifier: deps.cipher.encrypt(pkce.verifier),
          userEmail,
          createdAt: new Date().toISOString(),
        },
        OAUTH_STATE_TTL_SECONDS,
      );

      const url = new URL(server.auth.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", connection.clientId);
      url.searchParams.set("redirect_uri", callback);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", pkce.method);
      // RFC 8707. Sent whether or not this server acts on it, per the MCP spec:
      // it is what binds the token to this server and stops it being replayed
      // against another.
      url.searchParams.set("resource", server.auth.resource);
      if (connection.scopes.length > 0) {
        url.searchParams.set("scope", connection.scopes.join(" "));
      }
      return { authorizeUrl: url.toString() };
    },

    async completeAuthorization({ state, code, userEmail }) {
      // Consumed first and unconditionally: a replayed state must not be able to
      // bind a second token, whatever else about the request turns out to be
      // wrong.
      const pending = await deps.states.consume(state);
      if (!pending) {
        throw new ValidationError("This authorization link has expired or was already used.");
      }
      if (pending.userEmail !== userEmail) {
        throw new ForbiddenError("This authorization was started by a different user.");
      }
      // Re-checked here, not only at authorize time: ownership can change while
      // the user is away at the provider.
      await assertProjectOwner(deps.projects, pending.projectName, userEmail);

      const server = await requireOAuthServer(pending.serverName);
      const connection = await requireConnection(pending.projectName, pending.serverName);
      const target: TokenRequestTarget = {
        tokenEndpoint: server.auth.tokenEndpoint,
        clientId: connection.clientId,
        ...(connection.clientSecret
          ? { clientSecret: deps.cipher.decrypt(connection.clientSecret) }
          : {}),
        tokenEndpointAuthMethod: server.auth.tokenEndpointAuthMethod,
        resource: server.auth.resource,
      };
      const tokens = await deps.oauth.exchangeCode(target, {
        code,
        redirectUri: await redirectUri(),
        codeVerifier: deps.cipher.decrypt(pending.codeVerifier),
      });

      const now = new Date();
      await deps.connections.put({
        ...connection,
        accessToken: deps.cipher.encrypt(tokens.accessToken),
        ...(tokens.refreshToken
          ? { refreshToken: deps.cipher.encrypt(tokens.refreshToken) }
          : {}),
        ...(tokens.expiresInSeconds !== undefined
          ? { expiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000).toISOString() }
          : {}),
        // What the server actually granted, which may be narrower than asked.
        scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : connection.scopes,
        status: "connected",
        connectedBy: userEmail,
        connectedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      return { projectName: pending.projectName, serverName: pending.serverName };
    },

    async disconnect(projectName, serverName, userEmail) {
      await assertProjectOwner(deps.projects, projectName, userEmail);
      await requireConnection(projectName, serverName);
      await deps.connections.delete(projectName, serverName);
    },

    async listTools(projectName, serverName, userEmail) {
      await assertProjectOwner(deps.projects, projectName, userEmail);
      const server = await requireServer(serverName);
      try {
        // Re-checked here as at dispatch: the registry entry may have been
        // edited to a blocked host since it was stored.
        await deps.urlPolicy.assertAllowed(server.url);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Blocked URL" };
      }
      const headers = deps.cipher.decryptHeadersForOutbound(server.headers);
      if (server.auth) {
        const resolved = await deps.authProvider.headersFor(projectName, serverName);
        if (resolved.warning) {
          // The same sentence a run would report, so "why are there no tools"
          // has one answer wherever it is asked.
          return { ok: false, error: resolved.warning };
        }
        Object.assign(headers, resolved.headers);
      }
      return deps.probe.listTools(server.url, headers);
    },
  };
}
