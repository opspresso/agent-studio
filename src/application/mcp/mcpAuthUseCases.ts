/**
 * OAuth for registry MCP servers.
 *
 * Discovery runs once, when an admin registers or repairs a server, and stores
 * everything a run needs on the registry entry. Operator OAuth client settings
 * live there too; personal connections hold the resulting user grant. The run path
 * never reads a well-known document: that would add two round trips and a third party's
 * availability to every time-to-first-token.
 */

import { createHash } from "node:crypto";
import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServer, McpServerAuth, TokenEndpointAuthMethod } from "@/domain/mcp/types";
import type {
  AuthorizationServerMetadata,
  McpAuthProvider,
  OAuthClient,
  OAuthMetadataClient,
} from "@/domain/mcp/oauth";
import { McpMetadataError } from "@/domain/mcp/oauth";
import type { ListToolsResult, McpToolProbe } from "@/domain/mcp/toolProbe";
import type {
  McpConnection,
  McpConnectionRepository,
  McpOAuthStateRepository,
} from "@/domain/mcp/connection";
import { isAgentOwner } from "@/domain/agent/access";
import type { AgentRepository } from "@/domain/agent/repository";
import { resolveMcpAccountLookup, readMcpAccountLookup, isMcpAccountEndpoint, mcpAccountScopes, type McpAccountClient, type McpAccountResult, type McpAccountLookup } from "@/domain/mcp/account";
import type { HeaderOverrides, SecretCipher } from "@/domain/security/secretCipher";
import {
  mcpConnectionSecretContext,
  agentMcpHeadersContext,
  mcpOAuthClientSecretContext,
  mcpOAuthStateContext,
} from "@/domain/security/secretContext";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { resolveMcpBindings } from "@/application/agent/mcpBindingSettings";
import type { RunUser } from "@/domain/execution/actor";
import type { MemberRepository } from "@/domain/member/repository";
import { resolveAgentCaller } from "@/application/auth/resolveRunUser";
import { applyMcpUserEmail } from "@/application/mcpMetadataHeaders";
import { resolveMcpCredentials } from "./credentials";
import { listUserMcpConnections } from "./listConnections";
import { processManagedMcpLifecycleClaims } from "./managedMcpUseCases";
import { assertAllowedUrl } from "@/application/registry/registryUseCases";
import { skipsUrlGuard } from "@/domain/mcp/types";
import { createOAuthState, createPkcePair } from "@/shared/pkce";
import { log } from "@/shared/logger";
import { DEFAULT_SERVICE_NAME } from "@/shared/branding";
import { mapWithLimit } from "@/shared/mapWithLimit";
import { maskedMcpAuth } from "./mcpViews";
import { mcpTokenTarget, registryClientMismatch } from "./mcpOAuthClient";
import { mcpConnectionAuthMismatch } from "./mcpAuthProvider";

/**
 * Discovery either finishes, or stops to ask which authorization server to use.
 * RFC 9728 lets a resource advertise several and puts the choice on the client;
 * silently taking the first would bind every user's tokens to whichever the
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
/**
 * Give a failed metadata read a status.
 *
 * Every reason a read can fail is about the server or the network — it publishes
 * no well-known document, it answered with a login page, its host is refused by
 * the outbound guard. None of those are faults in this app, but as a bare error
 * `apiError` has nothing to map and answers 500, which is how an admin pointing
 * Discover at a server that simply does not do OAuth got `unhandled error` in
 * the logs and "Internal server error" in the console.
 *
 * Only {@link McpMetadataError} is remapped. Anything else still reaches 500,
 * because anything else really is ours.
 */
async function readMetadata<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof McpMetadataError) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
}

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

/**
 * RFC 9207 §2.4, applied before an authorization code is worth anything.
 *
 * This is the defence against a mix-up: every registry server shares one
 * callback URI, so without it a code issued by one authorization server can be
 * redeemed at another's token endpoint — handing that server a code it was
 * never granted. The comparison is deliberately literal (RFC 3986 §6.2.1
 * "simple string comparison"): normalising case, ports, trailing slashes or
 * percent-encoding is exactly what the spec forbids here, because each
 * normalisation is another way for two different issuers to compare equal.
 *
 * @throws {ValidationError} when the response cannot be attributed to the
 * issuer this flow was started against.
 */
function assertIssuerMatches(
  expected: { issuer: string; issParameterSupported?: boolean },
  iss: string | undefined,
): void {
  if (iss === undefined) {
    if (expected.issParameterSupported) {
      // The server told us it always sends one, so a response without it did
      // not come from the server we started with.
      throw new ValidationError(
        "The provider's redirect was missing the issuer identifier its metadata promises. The authorization was not completed.",
      );
    }
    return;
  }
  if (iss !== expected.issuer) {
    throw new ValidationError(
      "The provider's redirect came from a different authorization server than the one this connection was started against.",
    );
  }
}

/** How long a user has to finish an authorization before the state expires. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Where the authorization server sends the browser back. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcps/oauth/callback";

/** Shared installation metadata contains neither Agent names nor personal identities. */
export const MCP_CLIENT_METADATA_PATH = "/api/mcps/oauth/client-metadata";

/** The base URL with any trailing slashes removed, so paths append cleanly. */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The shared OAuth `client_id`: the address of this installation's metadata document.
 *
 * The spec requires the `client_id` **inside** the document to equal the URL the
 * document was fetched from, exactly — an authorization server that finds them
 * different rejects the authorization. That is why this and
 * {@link clientMetadataDocument} live together and why both build from the
 * configured public base rather than from a request: two places deriving the
 * same URL is precisely the drift the rule is checking for.
 */
export function clientMetadataUrl(baseUrl: string): string {
  return `${trimBase(baseUrl)}${MCP_CLIENT_METADATA_PATH}`;
}

/**
 * The document itself, as
 * [OAuth Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
 * defines it. `client_id`, `client_name` and `redirect_uris` are the required
 * three; the rest state what this client actually does.
 *
 * `token_endpoint_auth_method: "none"` is not a weakening — there is no secret
 * to hold. A self-hosted `client_id` is public by construction, which is why the
 * flow's defence is PKCE plus a redirect URI fixed here rather than a shared
 * secret: an authorization started by anyone else still lands its code at this
 * deployment's callback, where it is useless without the verifier.
 */
export function clientMetadataDocument(
  baseUrl: string,
  serviceName = DEFAULT_SERVICE_NAME,
): Record<string, unknown> {
  const base = trimBase(baseUrl);
  return {
    client_id: clientMetadataUrl(base),
    client_name: serviceName,
    client_uri: base,
    redirect_uris: [`${base}${MCP_OAUTH_CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Personal connection status; OAuth app secrets and tokens stay server-side. */
export interface McpConnectionView {
  serverName: string;
  status: McpConnection["status"];
  clientId: string;
  scopes: string[];
  connectedBy?: string;
  connectedAccount?: McpConnection["connectedAccount"];
  accountUnavailableReason?: Exclude<McpAccountResult["status"], "resolved">;
  connectedAt?: string;
  expiresAt?: string;
}

function toConnectionView(
  connection: McpConnection,
  accountUnavailableReason?: McpConnectionView["accountUnavailableReason"],
): McpConnectionView {
  return {
    serverName: connection.serverName,
    status: connection.status,
    clientId: connection.clientId,
    scopes: connection.scopes,
    ...(connection.connectedBy ? { connectedBy: connection.connectedBy } : {}),
    ...(connection.connectedAccount ? { connectedAccount: connection.connectedAccount } : {}),
    ...(accountUnavailableReason ? { accountUnavailableReason } : {}),
    ...(connection.connectedAt ? { connectedAt: connection.connectedAt } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
  };
}

function accountLookupId(auth: McpServerAuth, mcpUrl: string): string | undefined {
  const resolved = resolveMcpAccountLookup(auth);
  return resolved ? createHash("sha256").update(JSON.stringify({
    issuer: auth.issuer, resource: auth.resource, resolved,
    ...(resolved.lookup.kind === "mcp" ? { mcpUrl } : {}),
  })).digest("hex") : undefined;
}

export interface SaveOAuthClientCredentialsInput {
  /** Omitted preserves; empty removes the shared app. */
  clientId?: string;
  /** Omitted, empty or masked preserves the secret for the same Client ID. */
  clientSecret?: string;
  /** Must equal the configured deployment callback; empty restores that default. */
  redirectUri?: string;
  /** Null restores automatic discovery/presets; omission preserves the operator choice. */
  accountLookup?: McpAccountLookup | null;
}

export interface McpOAuthClientSettings {
  auth: McpServerAuth;
  defaultRedirectUri: string;
}

/**
 * The scopes a token response says were granted.
 *
 * RFC 6749 §5.1 delimits `scope` with spaces, and Slack delimits it with commas
 * — `channels:history,groups:history,…`. Splitting on spaces alone turns that
 * whole list into one "scope" that no display can wrap and no comparison can
 * match. A comma is technically legal inside a scope token, but no provider
 * issues one, whereas comma-delimited lists are shipping today.
 */
function parseGrantedScopes(scope: string): string[] {
  return scope.split(/[\s,]+/).filter(Boolean);
}

export interface McpAuthUseCasesDeps {
  serviceName: () => Promise<string>;
  lifecycleClaims?: Set<string>;
  mcps: McpRepository;
  agents: AgentRepository;
  members: Pick<MemberRepository, "getById">;
  connections: McpConnectionRepository;
  states: McpOAuthStateRepository;
  metadata: OAuthMetadataClient;
  oauth: OAuthClient;
  accounts: McpAccountClient;
  cipher: SecretCipher;
  urlPolicy: UrlPolicy;
  /** One-shot tool listing, shared with the registry's own probe. */
  probe: McpToolProbe;
  /** Resolves (and refreshes) the caller's outbound Authorization. */
  authProvider: McpAuthProvider;
  /** Absolute base of this deployment; the redirect URI is built from it. */
  publicBaseUrl: () => Promise<string | undefined>;
  /** DNS suffixes this deployment declared internal; see `skipsUrlGuard`. */
  internalHostSuffixes?: readonly string[];
  /**
   * Accept an authorization server that does not advertise PKCE. Off by
   * default — the spec says refuse — and a deployment's choice, not an entry's.
   */
  allowUnadvertisedPkce?: boolean;
}

export interface McpAuthUseCases {
  /**
   * Read the server's published metadata and store what an authorization needs.
   * Pass `authorizationServer` to answer a previous `choose` result.
   */
  discover(name: string, opts?: { authorizationServer?: string }): Promise<DiscoverAuthResult>;
  /** Drop the OAuth block, returning the entry to static-header behaviour. */
  clearAuth(name: string): Promise<void>;
  getOAuthClientSettings(name: string): Promise<McpOAuthClientSettings>;
  saveOAuthClientCredentials(
    name: string,
    input: SaveOAuthClientCredentialsInput,
  ): Promise<McpServerAuth>;

  listConnections(agentName: string, user: RunUser): Promise<McpConnectionView[]>;
  /** Returns the URL to send the browser to. */
  beginAuthorization(
    agentName: string,
    serverName: string,
    user: RunUser,
  ): Promise<{ authorizeUrl: string }>;
  completeAuthorization(params: {
    state: string;
    code: string;
    user: RunUser;
    /** RFC 9207, as the provider sent it. Validated before the code is redeemed. */
    iss?: string;
  }): Promise<{ agentName: string; serverName: string }>;
  /**
   * The provider redirected back with an error instead of a code.
   *
   * Routed through here rather than rendered straight from the query string so
   * the same RFC 9207 check runs first: the spec extends it to error responses
   * precisely because `error_description` is provider-controlled text that this
   * app would otherwise present as its own. Spends the state, since the flow it
   * belonged to is over either way.
   *
   * @returns the description that may safely be shown, if any.
   */
  abandonAuthorization(params: {
    state: string;
    user: RunUser;
    error: string;
    errorDescription?: string;
    iss?: string;
  }): Promise<{ error: string }>;
  disconnect(agentName: string, serverName: string, user: RunUser): Promise<void>;
  /** Probe with the caller's grant; only the Agent owner may supply draft binding headers. */
  listTools(
    agentName: string,
    serverName: string,
    user: RunUser,
    headerOverrides?: HeaderOverrides,
  ): Promise<ListToolsResult>;
}

export function createMcpAuthUseCases(deps: McpAuthUseCasesDeps): McpAuthUseCases {
  const lifecycleClaims = deps.lifecycleClaims ?? processManagedMcpLifecycleClaims();
  async function authorizeConnection(agentName: string, user: RunUser) {
    const current = await resolveAgentCaller(deps, agentName, user.userId);
    if (current.user.email !== user.email) throw new ForbiddenError("The authenticated account changed");
    return current.agent;
  }
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

  /**
   * The address this deployment is reachable at, which both the redirect target
   * and a client metadata document are built from. Never taken from the request:
   * a redirect target from caller input is the open-redirect this flow would
   * otherwise hand out, and a `client_id` from caller input is a document an
   * authorization server would fetch from somewhere we do not control.
   */
  async function publicBase(): Promise<string> {
    const base = await deps.publicBaseUrl();
    if (!base) {
      throw new ValidationError(
        "A public base URL must be configured before an OAuth connection can be authorized.",
      );
    }
    return base;
  }

  async function redirectUri(configured?: string): Promise<string> {
    const uri = `${trimBase(await publicBase())}${MCP_OAUTH_CALLBACK_PATH}`;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ValidationError("PUBLIC_BASE_URL must be a valid URL.");
    }
    if (
      (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== MCP_OAUTH_CALLBACK_PATH
    ) {
      throw new ValidationError("PUBLIC_BASE_URL must be an https origin (or localhost), without credentials, a path, query or fragment.");
    }
    if (configured && configured !== uri) {
      throw new ValidationError(`The OAuth redirect URI must match this deployment's callback: ${uri}. Update the MCP settings and provider registration.`);
    }
    return uri;
  }

  /**
   * The document's own address, but only when an authorization server could
   * actually fetch it.
   *
   * A metadata-document `client_id` is not a name the server looks up — it is a
   * URL the server **retrieves**, from wherever the provider runs. A base URL
   * that is `http://localhost:3000`, an internal hostname, or anything else off
   * the public internet therefore produces a `client_id` that resolves to
   * nothing, and the provider says so in its own words much later: the user
   * approves the connection and lands on *Unknown OAuth client*, with the
   * failure attributed to a client that looked perfectly well-formed here.
   *
   * The same predicate the entry's own endpoints face, because it is the same
   * question — an https URL at a publicly routable address. `undefined` sends
   * the caller to the next way of getting a client, which is what the fallback
   * order exists for: a provider offering registration as well is not out of
   * options just because this deployment cannot host a document. A failed
   * policy lookup is not a verdict about that address and must not create a
   * different client through registration.
   */
  async function servableMetadataUrl(): Promise<string | undefined> {
    const url = clientMetadataUrl(await publicBase());
    try {
      await assertAuthEndpoint(deps.urlPolicy, url, "Client ID metadata document");
      return url;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return undefined;
    }
  }

  async function requireConnection(
    userId: string,
    serverName: string,
  ): Promise<McpConnection> {
    const connection = await deps.connections.get(userId, serverName);
    if (!connection) {
      throw new NotFoundError(
        `Your account has no connection to MCP server "${serverName}".`,
      );
    }
    return connection;
  }

  async function saveAuth(server: McpServer, auth: McpServerAuth | undefined): Promise<void> {
    if (lifecycleClaims.has(server.name)) {
      throw new ConflictError(`A lifecycle operation for "${server.name}" is already running.`);
    }
    lifecycleClaims.add(server.name);
    try {
      const saved = await deps.mcps.updateAuth(
        server.name, server.url, auth, new Date().toISOString(), { auth: server.auth },
      );
      if (!saved) {
        throw new ConflictError(
          `MCP server "${server.name}" was removed, moved or had its OAuth configuration changed. Please reload and retry.`,
        );
      }
    } finally {
      lifecycleClaims.delete(server.name);
    }
  }

  return {
    async discover(name, opts) {
      const server = await requireServer(name);
      // The same predicate the run path and the tool probe use, for the same
      // reason. Without it this was the one place that reached for the guard
      // directly, so an entry this deployment declared internal could be
      // registered and dialed by a run but never discovered.
      const loopback = skipsUrlGuard(server, deps.internalHostSuffixes);
      const resourceMetadata = await readMetadata(() =>
        deps.metadata.fetchProtectedResource(server.url, loopback),
      );

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

      const asMetadata = await readMetadata(() =>
        deps.metadata.fetchAuthorizationServer(authorizationServer),
      );
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
      if (asMetadata.userInfoEndpoint) {
        if (!isMcpAccountEndpoint(asMetadata.userInfoEndpoint)) throw new ValidationError("UserInfo endpoint must be HTTPS without embedded credentials or a fragment.");
        await assertAuthEndpoint(deps.urlPolicy, asMetadata.userInfoEndpoint, "UserInfo endpoint");
      }
      // The spec's MUST (2026-07-28, authorization security considerations):
      // a server that does not advertise `code_challenge_methods_supported`
      // may be one that ignores `code_challenge`, and proceeding against it
      // silently gives up the code-injection protection PKCE is for. Many
      // servers do support PKCE without advertising it, which is what the
      // deployment-level override is for — a choice an operator makes once,
      // in the environment, not a default.
      const pkce = asMetadata.codeChallengeMethodsSupported;
      if (!pkce && !deps.allowUnadvertisedPkce) {
        throw new ValidationError(
          `Authorization server does not advertise PKCE (no code_challenge_methods_supported), which this client requires. Set MCP_OAUTH_ALLOW_UNADVERTISED_PKCE=true to accept it anyway.`,
        );
      }
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
        // What the server published, not the URL we asked at: this is the value
        // a callback's `iss` is compared against, so it has to be the server's
        // own claim about its identity.
        issuer: asMetadata.issuer,
        ...(asMetadata.issParameterSupported ? { issParameterSupported: true } : {}),
        authorizationEndpoint: asMetadata.authorizationEndpoint,
        tokenEndpoint: asMetadata.tokenEndpoint,
        ...(asMetadata.userInfoEndpoint ? {
          userInfoEndpoint: asMetadata.userInfoEndpoint,
          userInfoScopes: ["openid", ...["email", "profile"].filter(scope => asMetadata.scopesSupported?.includes(scope))],
        } : {}),
        ...(asMetadata.registrationEndpoint
          ? { registrationEndpoint: asMetadata.registrationEndpoint }
          : {}),
        ...(asMetadata.clientIdMetadataDocumentSupported
          ? { clientIdMetadataDocumentSupported: true }
          : {}),
        tokenEndpointAuthMethod: selectAuthMethod(asMetadata),
        ...(scopesSupported ? { scopesSupported } : {}),
        ...(server.auth?.issuer === asMetadata.issuer && server.auth.clientId
          ? { clientId: server.auth.clientId }
          : {}),
        ...(server.auth?.issuer === asMetadata.issuer && server.auth.clientSecret
          ? { clientSecret: server.auth.clientSecret }
          : {}),
        ...(server.auth?.issuer === asMetadata.issuer && server.auth.redirectUri
          ? { redirectUri: server.auth.redirectUri }
          : {}),
        ...(server.auth?.issuer === asMetadata.issuer && server.auth.accountLookup
          ? { accountLookup: server.auth.accountLookup } : {}),
        discoveredAt: new Date().toISOString(),
      };
      await saveAuth(server, auth);
      return { status: "discovered", auth: maskedMcpAuth(deps.cipher, name, auth) };
    },

    async clearAuth(name) {
      const server = await requireServer(name);
      await saveAuth(server, undefined);
    },

    async getOAuthClientSettings(name) {
      const server = await requireOAuthServer(name);
      return {
        auth: maskedMcpAuth(deps.cipher, name, server.auth),
        defaultRedirectUri: await redirectUri(),
      };
    },

    async saveOAuthClientCredentials(name, input) {
      const server = await requireOAuthServer(name);
      const { clientId: previousId, clientSecret: previousSecret, redirectUri: previousRedirect, ...metadata } = server.auth;
      const clientId = input.clientId === undefined ? previousId : input.clientId.trim();
      const redirect = input.redirectUri === undefined ? previousRedirect : input.redirectUri.trim();
      if (redirect) await redirectUri(redirect);
      let accountLookup = server.auth.accountLookup;
      if (input.accountLookup === null) accountLookup = undefined;
      else if (input.accountLookup !== undefined) {
        accountLookup = readMcpAccountLookup(input.accountLookup);
        if (!accountLookup) throw new ValidationError("Invalid account lookup contract.");
        if (accountLookup.kind === "http") await assertAuthEndpoint(deps.urlPolicy, accountLookup.endpoint, "Account endpoint");
      }
      const submitted = input.clientSecret;
      const preserveSecret = submitted === undefined || submitted === "" || deps.cipher.isMasked(submitted);
      // A mask confirms only a secret held for this same client, never a new app.
      const clientSecret = clientId
        ? preserveSecret
          ? clientId === previousId ? previousSecret : undefined
          : deps.cipher.encrypt(submitted, mcpOAuthClientSecretContext(name))
        : undefined;
      const nextAuth: McpServerAuth = {
        ...metadata,
        accountLookup,
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(redirect ? { redirectUri: redirect } : {}),
      };
      await saveAuth(server, nextAuth);
      return maskedMcpAuth(deps.cipher, name, nextAuth);
    },

    async listConnections(agentName, user) {
      await authorizeConnection(agentName, user);
      const connections = await listUserMcpConnections(deps.connections, user.userId);
      // Existing grants can supply their provider identity without reconnecting. Limit
      // optional network reads; resolved identities survive subsequent token refreshes.
      async function viewConnection(connection: McpConnection, lookupAllowed: boolean): Promise<McpConnectionView | undefined> {
        const server = await deps.mcps.get(connection.serverName);
        const lookupId = server?.auth && accountLookupId(server.auth, server.url);
        const withoutAccount = { ...connection, connectedAccount: undefined };
        if (!server?.auth || !lookupId) return toConnectionView(withoutAccount,
          server?.auth?.accountLookup?.kind === "none" ? "disabled" : "not_configured");
        if (mcpConnectionAuthMismatch(connection, connection.serverName, server.auth)) {
          return toConnectionView(withoutAccount, "unavailable");
        }
        if (connection.connectedAccount && connection.accountLookupId === lookupId) return toConnectionView(connection);
        if (!lookupAllowed || connection.status !== "connected" || !connection.accessToken) {
          return toConnectionView(withoutAccount, "unavailable");
        }
        // Display reads never rotate a grant or spend an expired token.
        if (connection.expiresAt && !(Date.parse(connection.expiresAt) > Date.now())) return toConnectionView(withoutAccount, "unavailable");
        const accessToken = deps.cipher.decrypt(connection.accessToken,
          mcpConnectionSecretContext(user.userId, connection.serverName, "access-token"));
        const identity = await deps.accounts.read(server.auth, accessToken, { mcpUrl: server.url, loopback: skipsUrlGuard(server, deps.internalHostSuffixes) });
        if (identity.status !== "resolved") return toConnectionView(withoutAccount, identity.status);
        const identified = { ...connection, connectedAccount: identity.account, accountLookupId: lookupId };
        if (await deps.connections.updateAccount(connection, identity.account, lookupId)) return toConnectionView(identified);
        // Do not display the old account over a newer grant or resurrect a disconnect.
        const latest = await deps.connections.get(user.userId, connection.serverName);
        // Revalidate the winning snapshot against current registry settings, without
        // retrying a lookup that already lost its grant revision.
        return latest ? viewConnection(latest, false) : undefined;
      }
      const views = await mapWithLimit(connections, 4, connection => viewConnection(connection, true));
      return views.filter((view): view is McpConnectionView => view !== undefined);
    },

    async beginAuthorization(agentName, serverName, user) {
      await authorizeConnection(agentName, user);
      const server = await requireOAuthServer(serverName);
      const callback = await redirectUri(server.auth.redirectUri);
      const issuer = server.auth.issuer;
      let connection = await deps.connections.get(user.userId, serverName);

      /**
       * SEP-2352: a `client_id` means nothing away from the server that issued
       * it. Re-running discovery rewrites the registry entry's authorization
       * server and never touches these rows, so without this check the next
       * authorization would present one server's client to another — and the
       * tokens it already holds were granted by a server this entry no longer
       * points at.
       */
      const staleCredentials =
        connection?.clientId !== undefined &&
        // A metadata-document client is exempt, and this is the one place the
        // exemption matters. Such a `client_id` is a URL this deployment hosts
        // and any authorization server resolves on demand, so it is still the
        // same client after the entry moves — refusing it here would break a
        // working connection to enforce a rule about credentials it does not
        // have.
        connection.clientFromMetadataDocument !== true &&
        connection.issuer !== issuer;
      // Offered *and* fetchable: a document at an address the provider cannot
      // reach is not a route, and taking it anyway dead-ends at the provider
      // with a message about a client rather than about a URL.
      const metadataUrl = !server.auth.clientId && server.auth.clientIdMetadataDocumentSupported
        ? await servableMetadataUrl()
        : undefined;

      /**
       * A stored document `client_id` that is no longer the one this deployment
       * would serve — because the public base moved, or because it stopped being
       * an address a provider can fetch from at all.
       *
       * Rebuilt rather than reused, and it is the difference between the mistake
       * self-healing and being permanent: the row below still has a `clientId`,
       * so without this the next attempt sails past every branch and presents
       * the same unfetchable URL again. Nothing is lost by rebuilding — such a
       * client holds no secret, and the tokens it authorized were granted to a
       * `client_id` that no longer resolves.
       */
      const staleDocument =
        connection?.clientFromMetadataDocument === true && connection.clientId !== metadataUrl;

      // Reuse a current client; otherwise choose the administrator's shared app,
      // then a fetchable metadata document, then the server's dynamic registration.
      const configuredClientChanged = server.auth.clientId
        ? connection?.clientFromRegistry !== true || connection.clientId !== server.auth.clientId
        : connection?.clientFromRegistry === true;
      if (!connection?.clientId || staleCredentials || staleDocument || configuredClientChanged) {
        const scopes = mcpAccountScopes(server.auth, connection?.scopes ?? server.auth.scopesSupported ?? []);
        // Rebuilt rather than merged in either branch: whatever the previous
        // client authorized was granted by a different server, and must not
        // survive into this one.
        const base = {
          userId: user.userId,
          serverName,
          issuer,
          resource: server.auth.resource,
          scopes,
          status: "needs_auth" as const,
          updatedAt: new Date().toISOString(),
        };
        let fresh: McpConnection;
        if (server.auth.clientId) {
          fresh = { ...base, clientId: server.auth.clientId, clientFromRegistry: true };
        } else if (metadataUrl) {
          // Nothing is requested and nothing is issued: the `client_id` is the
          // address of a document this deployment already serves, and the
          // server fetches it when the authorization arrives.
          fresh = {
            ...base,
            clientId: metadataUrl,
            clientFromMetadataDocument: true,
          };
        } else if (server.auth.registrationEndpoint) {
          const registered = await deps.oauth.register({
            registrationEndpoint: server.auth.registrationEndpoint,
            clientName: await deps.serviceName(),
            redirectUri: callback,
            scopes,
            // The method the token requests will prove themselves with: a
            // registration that said `post` while the exchange sent `basic`
            // was refused as `invalid_client` by every server that enforces
            // what it recorded.
            tokenEndpointAuthMethod: server.auth.tokenEndpointAuthMethod,
          });
          fresh = {
            ...base,
            clientId: registered.clientId,
            ...(registered.clientSecret
              ? {
                  clientSecret: deps.cipher.encrypt(
                    registered.clientSecret,
                    mcpConnectionSecretContext(user.userId, serverName, "client-secret"),
                  ),
                }
              : {}),
            // What the server recorded wins over what was asked for.
            ...(registered.tokenEndpointAuthMethod
              ? { tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod }
              : {}),
          };
        } else if (server.auth.clientIdMetadataDocumentSupported) {
          // The provider's side is fine and ours is not, so saying it "supports
          // neither" would send the user to the provider over a setting of
          // ours. Named here because the alternative is finding out from the
          // provider, after approving, as *Unknown OAuth client*.
          throw new ValidationError(
            `MCP server "${serverName}" accepts client ID metadata documents, but this deployment's public base URL (${await publicBase()}) is not one an authorization server can fetch a document from — it has to be a public https address. Set PUBLIC_BASE_URL to one, or ask an administrator to register an app and save its client ID and secret in Tools > OAuth.`,
          );
        } else {
          throw new ValidationError(
            `MCP server "${serverName}" supports neither client ID metadata documents nor dynamic client registration. Register an app with the provider and have an administrator save its client ID and secret in Tools > OAuth.`,
          );
        }
        if (!await deps.connections.putIfCurrent(fresh, connection)) {
          throw new ConflictError(`The connection to "${serverName}" changed while authorization was starting. Connect again.`);
        }
        connection = fresh;
      }

      const scopes = mcpAccountScopes(server.auth, connection.scopes);
      const pkce = createPkcePair();
      const state = createOAuthState();
      await deps.states.put(
        {
          state,
          agentName,
          serverName,
          codeVerifier: deps.cipher.encrypt(pkce.verifier, mcpOAuthStateContext(state)),
          userEmail: user.email,
          userId: user.userId,
          redirectUri: callback,
          clientId: connection.clientId,
          ...(connection.clientFromRegistry ? { clientFromRegistry: true } : {}),
          resource: server.auth.resource,
          scopes,
          // Recorded alongside the verifier, as RFC 9207 requires: the registry
          // entry is exactly what may change while the user is at the provider,
          // so reading the expected issuer back off it would compare the
          // response against whatever the entry says by the time it returns.
          issuer,
          ...(server.auth.issParameterSupported ? { issParameterSupported: true } : {}),
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
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "));
      }
      return { authorizeUrl: url.toString() };
    },

    async completeAuthorization({ state, code, user, iss }) {
      // Consumed first and unconditionally: a replayed state must not be able to
      // bind a second token, whatever else about the request turns out to be
      // wrong.
      const pending = await deps.states.consume(state);
      if (!pending) {
        throw new ValidationError("This authorization link has expired or was already used.");
      }
      if (pending.userId !== user.userId || pending.userEmail !== user.email) {
        throw new ForbiddenError("This authorization was started by a different user.");
      }
      // Before the code goes anywhere. RFC 9207 §2.4 places this ahead of the
      // token request because the whole point is to not hand the code to a
      // token endpoint that did not issue it.
      assertIssuerMatches(pending, iss);
      // Re-checked here, not only at authorize time: account access can change while
      // the user is away at the provider.
      await authorizeConnection(pending.agentName, user);

      const server = await requireOAuthServer(pending.serverName);
      // The entry may have been repointed while the user was at the provider.
      // Redeeming at the new server's token endpoint would send it a code its
      // authorization server never issued. Compare the stored issuer exactly.
      if (server.auth.issuer !== pending.issuer) {
        throw new ValidationError(
          `The authorization server configured for "${pending.serverName}" changed while this authorization was in progress. Please connect it again.`,
        );
      }
      const connection = await requireConnection(user.userId, pending.serverName);
      if (
        registryClientMismatch(connection, server.auth) ||
        pending.clientId !== connection.clientId ||
        Boolean(pending.clientFromRegistry) !== Boolean(connection.clientFromRegistry) ||
        pending.resource !== server.auth.resource
      ) {
        throw new ValidationError("The OAuth client or resource changed during authorization. Please connect again.");
      }
      const target = mcpTokenTarget(deps.cipher, connection, server.auth);
      const tokens = await deps.oauth.exchangeCode(target, {
        code,
        redirectUri: pending.redirectUri,
        codeVerifier: deps.cipher.decrypt(
          pending.codeVerifier,
          mcpOAuthStateContext(pending.state),
        ),
      });
      const now = new Date();
      const identity = await deps.accounts.read(server.auth, tokens.accessToken, { mcpUrl: server.url, loopback: skipsUrlGuard(server, deps.internalHostSuffixes) });
      const {
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        expiresAt: _expiresAt,
        connectedAccount: _connectedAccount,
        accountLookupId: _accountLookupId,
        ...credentials
      } = connection;
      void _accessToken, _refreshToken, _expiresAt, _connectedAccount, _accountLookupId;
      const completed: McpConnection = {
        ...credentials,
        // Store the issuer and resource used for this exact exchange.
        issuer: server.auth.issuer,
        resource: server.auth.resource,
        accessToken: deps.cipher.encrypt(
          tokens.accessToken,
          mcpConnectionSecretContext(
            pending.userId,
            pending.serverName,
            "access-token",
          ),
        ),
        ...(tokens.refreshToken
          ? {
              refreshToken: deps.cipher.encrypt(
                tokens.refreshToken,
                mcpConnectionSecretContext(
                  pending.userId,
                  pending.serverName,
                  "refresh-token",
                ),
              ),
            }
          : {}),
        ...(tokens.expiresInSeconds !== undefined
          ? { expiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000).toISOString() }
          : {}),
        // What the server actually granted, which may be narrower than asked.
        scopes: tokens.scope ? parseGrantedScopes(tokens.scope) : pending.scopes,
        status: "connected",
        connectedBy: user.email,
        ...(identity.status === "resolved" ? { connectedAccount: identity.account, accountLookupId: accountLookupId(server.auth, server.url) } : {}),
        connectedAt: now.toISOString(),
        authorizationEpoch: createHash("sha256").update(pending.state).digest("hex"),
        updatedAt: now.toISOString(),
      };
      if (!await deps.connections.putIfCurrent(completed, connection)) {
        throw new ConflictError(`The connection to "${pending.serverName}" changed while authorization was completing. Connect again.`);
      }
      return { agentName: pending.agentName, serverName: pending.serverName };
    },

    async abandonAuthorization({ state, user, error, errorDescription, iss }) {
      const pending = await deps.states.consume(state);
      if (!pending) {
        throw new ValidationError("This authorization link has expired or was already used.");
      }
      if (pending.userId !== user.userId || pending.userEmail !== user.email) {
        throw new ForbiddenError("This authorization was started by a different user.");
      }
      // Throws on mismatch, which is what stops provider-controlled text from
      // being relayed: the caller renders its own message instead.
      assertIssuerMatches(pending, iss);
      return { error: errorDescription ?? error };
    },

    async disconnect(agentName, serverName, user) {
      await authorizeConnection(agentName, user);
      const connection = await requireConnection(user.userId, serverName);
      if (!await deps.connections.deleteIfCurrent(connection)) {
        throw new ConflictError(`The connection to "${serverName}" changed while it was being disconnected. Reload and retry.`);
      }
    },

    async listTools(agentName, serverName, user, headerOverrides) {
      const agent = await authorizeConnection(agentName, user);
      if (headerOverrides !== undefined && !isAgentOwner(agent, user.email)) {
        throw new ForbiddenError("Only the Agent owner may probe draft binding headers");
      }
      const server = await requireServer(serverName);
      const loopback = skipsUrlGuard(server, deps.internalHostSuffixes);
      if (!loopback) {
        try {
          // Re-checked here as at dispatch: the registry entry may have been
          // edited to a blocked host since it was stored.
          await deps.urlPolicy.assertAllowed(server.url);
        } catch (error) {
          if (!(error instanceof BlockedUrlError)) throw error;
          return { ok: false, error: error.message };
        }
      }
      const [binding] = await resolveMcpBindings(deps.cipher, { get: async () => server },
        [{ name: serverName, ...(headerOverrides === undefined ? {} : { headers: headerOverrides }) }],
        agent.configuration?.mcpList ?? [], name => agentMcpHeadersContext(agentName, name));
      const credentials = await resolveMcpCredentials({ cipher: deps.cipher, auth: deps.authProvider }, agentName, server, binding, user);
      if (credentials.unavailable) return { ok: false, error: credentials.unavailable };
      const headers = credentials.headers;
      applyMcpUserEmail(headers, user.email);
      const result = await deps.probe.listTools(server.url, headers, loopback);
      if (!result.ok && result.unauthorized && credentials.credentialFingerprint) {
        // What a run does with the same 401: record it, so the console offers a
        // reconnect instead of leaving the user to re-diagnose the message.
        await deps.authProvider.markUnauthorized(user.userId, serverName, credentials.credentialFingerprint, result.scope).catch((error: unknown) => {
          log.warn("mcp", `could not flag '${serverName}' as needing reauthorization`, error);
        });
      }
      return result;
    },
  };
}
