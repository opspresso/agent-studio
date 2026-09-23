/**
 * OAuth for registry MCP servers.
 *
 * Discovery runs once, when an admin registers or repairs a server, and stores
 * everything a run needs on the registry entry. Operator OAuth client settings
 * live there too; project connections hold the resulting user grant. The run path
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
import type { ProjectRepository } from "@/domain/project/repository";
import type { HeaderOverrides, SecretCipher } from "@/domain/security/secretCipher";
import {
  mcpConnectionSecretContext,
  mcpHeadersContext,
  agentMcpHeadersContext,
  mcpOAuthClientSecretContext,
  mcpOAuthStateContext,
} from "@/domain/security/secretContext";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { resolveMcpBindings } from "@/application/project/mcpBindingSettings";
import { assertProjectOwnerOrAdminReadable, assertProjectWritable } from "@/application/project/projectUseCases";
import { applyMcpUserEmail, stripMcpMetadataHeaders } from "@/application/mcpMetadataHeaders";
import { listProjectMcpConnections } from "./listConnections";
import { processManagedMcpLifecycleClaims } from "./managedMcpUseCases";
import { assertAllowedUrl } from "@/application/registry/registryUseCases";
import { skipsUrlGuard } from "@/domain/mcp/types";
import { createOAuthState, createPkcePair } from "@/shared/pkce";
import { log } from "@/shared/logger";
import { DEFAULT_SERVICE_NAME } from "@/shared/branding";
import { maskedMcpAuth } from "./mcpViews";
import { mcpTokenTarget, registryClientMismatch } from "./mcpOAuthClient";

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

/**
 * Where this deployment publishes a project's Client ID Metadata Document.
 *
 * One document per project rather than one for the deployment, because the
 * document is what an authorization server shows the person approving the
 * connection. Its client name includes this deployment's display name and the
 * Agent name so the reader can identify both.
 */
export const MCP_CLIENT_METADATA_PATH = "/api/mcps/oauth/client-metadata";

/** The base URL with any trailing slashes removed, so paths append cleanly. */
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The `client_id` a project presents: the address of its metadata document.
 *
 * The spec requires the `client_id` **inside** the document to equal the URL the
 * document was fetched from, exactly — an authorization server that finds them
 * different rejects the authorization. That is why this and
 * {@link clientMetadataDocument} live together and why both build from the
 * configured public base rather than from a request: two places deriving the
 * same URL is precisely the drift the rule is checking for.
 */
export function clientMetadataUrl(baseUrl: string, projectName: string): string {
  return `${trimBase(baseUrl)}${MCP_CLIENT_METADATA_PATH}/${projectName}`;
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
  projectName: string,
  serviceName = DEFAULT_SERVICE_NAME,
): Record<string, unknown> {
  const base = trimBase(baseUrl);
  return {
    client_id: clientMetadataUrl(base, projectName),
    client_name: `${serviceName} — ${projectName}`,
    client_uri: base,
    redirect_uris: [`${base}${MCP_OAUTH_CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * A connection as the console may see it.
 *
 * The client secret is masked the way every other stored secret in this codebase
 * is — length-preserving, edges revealed in proportion to length — so an owner
 * can recognise which credential is stored without it being readable. Tokens are
 * absent entirely: unlike the project API token there is no
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
    ...(connection.clientSecret
      ? {
          clientSecret: cipher.mask(
            connection.clientSecret,
            mcpConnectionSecretContext(
              connection.projectName,
              connection.serverName,
              "client-secret",
            ),
          ),
        }
      : {}),
    clientRegistered: connection.clientRegistered === true,
    scopes: connection.scopes,
    ...(connection.connectedBy ? { connectedBy: connection.connectedBy } : {}),
    ...(connection.connectedAt ? { connectedAt: connection.connectedAt } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
  };
}

export interface SaveClientCredentialsInput {
  clientId: string;
  /**
   * An omitted or masked-echo value keeps what is stored; an empty one clears
   * it, which is the only way back from a confidential client to a public one.
   * Unlike the console's other secret fields this one arrives prefilled with the
   * mask, so emptying it is a deliberate act rather than "I typed nothing".
   */
  clientSecret?: string;
  scopes?: string[];
}

export interface SaveOAuthClientCredentialsInput {
  /** Omitted preserves; empty removes the shared app. */
  clientId?: string;
  /** Omitted, empty or masked preserves the secret for the same Client ID. */
  clientSecret?: string;
  /** Must equal the configured deployment callback; empty restores that default. */
  redirectUri?: string;
}

export interface McpOAuthClientSettings {
  auth: McpServerAuth;
  defaultRedirectUri: string;
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((scope, index) => scope === b[index]);
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
  serviceName: string;
  lifecycleClaims?: Set<string>;
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
    /** RFC 9207, as the provider sent it. Validated before the code is redeemed. */
    iss?: string;
  }): Promise<{ projectName: string; serverName: string }>;
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
    userEmail: string;
    error: string;
    errorDescription?: string;
    iss?: string;
  }): Promise<{ error: string }>;
  disconnect(projectName: string, serverName: string, userEmail: string): Promise<void>;
  /**
   * What this server offers *this project*. The registry's own probe carries
   * only the entry's static headers, so against an OAuth server it can do
   * nothing but 401 — the credential that would answer belongs to the project.
   *
   * `headerOverrides` is the binding's own layer, passed so the answer matches
   * what a run would offer. Owner-gated like the rest of this use case: it
   * spends the project's connection and sends the caller's headers with it.
   */
  listTools(
    projectName: string,
    serverName: string,
    userEmail: string,
    headerOverrides?: HeaderOverrides,
  ): Promise<ListToolsResult>;
}

export function createMcpAuthUseCases(deps: McpAuthUseCasesDeps): McpAuthUseCases {
  const lifecycleClaims = deps.lifecycleClaims ?? processManagedMcpLifecycleClaims();
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
   * options just because this deployment cannot host a document.
   */
  async function servableMetadataUrl(projectName: string): Promise<string | undefined> {
    const url = clientMetadataUrl(await publicBase(), projectName);
    try {
      await assertAuthEndpoint(deps.urlPolicy, url, "Client ID metadata document");
      return url;
    } catch {
      return undefined;
    }
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
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(redirect ? { redirectUri: redirect } : {}),
      };
      await saveAuth(server, nextAuth);
      return maskedMcpAuth(deps.cipher, name, nextAuth);
    },

    async listConnections(projectName, userEmail) {
      await assertProjectOwnerOrAdminReadable(deps.projects, projectName, userEmail);
      return (await listProjectMcpConnections(deps.connections, projectName)).map((connection) =>
        toConnectionView(deps.cipher, connection),
      );
    },

    async saveClientCredentials(projectName, serverName, input, userEmail) {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const server = await requireOAuthServer(serverName);
      const existing = await deps.connections.get(projectName, serverName);

      // An omitted or masked secret keeps what is stored, matching how every
      // other stored secret in this codebase behaves on update. An empty one
      // clears it — see SaveClientCredentialsInput for why this field differs.
      const submitted = input.clientSecret;
      const clientSecret =
        submitted === undefined || deps.cipher.isMasked(submitted)
          ? existing?.clientSecret
          : submitted === ""
            ? undefined
            : deps.cipher.encrypt(
                submitted,
                mcpConnectionSecretContext(projectName, serverName, "client-secret"),
              );
      const scopes = input.scopes ?? existing?.scopes ?? server.auth.scopesSupported ?? [];

      const issuer = server.auth.issuer;

      // Saving credentials that did not change is a no-op, not a reset. Both
      // boxes arrive prefilled from the stored connection, so pressing Save
      // without editing anything is the likeliest press there is — and it must
      // not cost the project the tokens those very credentials authorized.
      if (
        existing &&
        existing.clientId === input.clientId &&
        existing.clientSecret === clientSecret &&
        sameScopes(existing.scopes, scopes) &&
        existing.issuer === issuer
      ) {
        return toConnectionView(deps.cipher, existing);
      }

      const next: McpConnection = {
        projectName,
        serverName,
        clientId: input.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        // Whatever the owner just typed was registered with the server this
        // entry points at now; that is what makes it re-checkable later. The
        // audience goes with it, on the other axis.
        issuer,
        resource: server.auth.resource,
        scopes,
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
      await assertProjectWritable(deps.projects, projectName, userEmail);
      const server = await requireOAuthServer(serverName);
      const callback = await redirectUri(server.auth.redirectUri);
      const issuer = server.auth.issuer;
      let connection = await deps.connections.get(projectName, serverName);

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
      if (staleCredentials && connection?.clientRegistered !== true &&
          !server.auth.clientId && connection?.clientFromRegistry !== true) {
        // Hand-entered credentials cannot be re-issued on the owner's behalf.
        throw new ValidationError(
          `The client credentials stored for "${serverName}" were registered with a different authorization server (${connection?.issuer}). Register an app with ${issuer} and save its client ID and secret before connecting.`,
        );
      }

      // Offered *and* fetchable: a document at an address the provider cannot
      // reach is not a route, and taking it anyway dead-ends at the provider
      // with a message about a client rather than about a URL.
      const metadataUrl = !server.auth.clientId && server.auth.clientIdMetadataDocumentSupported
        ? await servableMetadataUrl(projectName)
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

      // No client yet, or one that belongs to a server this entry has moved off,
      // or a document address this deployment no longer serves. The order is the
      // spec's: credentials already held (hand-entered ones reach here as
      // `connection.clientId`), then a metadata document, then registration, then
      // nothing this app can do on the owner's behalf.
      //
      // Registration is last because the revision deprecates it — but it is
      // still here, because a server on a 2025-era release offers no metadata
      // document and asking its owner to go and register an app by hand is not
      // an upgrade path, it is a working entry that stopped working.
      const configuredClientChanged = server.auth.clientId
        ? connection?.clientFromRegistry !== true || connection.clientId !== server.auth.clientId
        : connection?.clientFromRegistry === true;
      if (!connection?.clientId || staleCredentials || staleDocument || configuredClientChanged) {
        const scopes = connection?.scopes ?? server.auth.scopesSupported ?? [];
        // Rebuilt rather than merged in either branch: whatever the previous
        // client authorized was granted by a different server, and must not
        // survive into this one.
        const base = {
          projectName,
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
            clientName: `${deps.serviceName} — ${projectName}`,
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
                    mcpConnectionSecretContext(projectName, serverName, "client-secret"),
                  ),
                }
              : {}),
            clientRegistered: true,
            // What the server recorded wins over what was asked for.
            ...(registered.tokenEndpointAuthMethod
              ? { tokenEndpointAuthMethod: registered.tokenEndpointAuthMethod }
              : {}),
          };
        } else if (server.auth.clientIdMetadataDocumentSupported) {
          // The provider's side is fine and ours is not, so saying it "supports
          // neither" would send the owner to the provider over a setting of
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
        await deps.connections.put(fresh);
        connection = fresh;
      }

      const pkce = createPkcePair();
      const state = createOAuthState();
      await deps.states.put(
        {
          state,
          projectName,
          serverName,
          codeVerifier: deps.cipher.encrypt(pkce.verifier, mcpOAuthStateContext(state)),
          userEmail,
          redirectUri: callback,
          clientId: connection.clientId,
          ...(connection.clientFromRegistry ? { clientFromRegistry: true } : {}),
          resource: server.auth.resource,
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
      if (connection.scopes.length > 0) {
        url.searchParams.set("scope", connection.scopes.join(" "));
      }
      return { authorizeUrl: url.toString() };
    },

    async completeAuthorization({ state, code, userEmail, iss }) {
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
      // Before the code goes anywhere. RFC 9207 §2.4 places this ahead of the
      // token request because the whole point is to not hand the code to a
      // token endpoint that did not issue it.
      assertIssuerMatches(pending, iss);
      // Re-checked here, not only at authorize time: ownership can change while
      // the user is away at the provider.
      await assertProjectWritable(deps.projects, pending.projectName, userEmail);

      const server = await requireOAuthServer(pending.serverName);
      // The entry may have been repointed while the user was at the provider.
      // Redeeming at the new server's token endpoint would send it a code its
      // authorization server never issued. Skipped for a state that predates the
      // recorded issuer, which has nothing to compare.
      if (server.auth.issuer !== pending.issuer) {
        throw new ValidationError(
          `The authorization server configured for "${pending.serverName}" changed while this authorization was in progress. Please connect it again.`,
        );
      }
      const connection = await requireConnection(pending.projectName, pending.serverName);
      if (
        registryClientMismatch(connection, server.auth) ||
        (pending.clientId !== undefined && (
          pending.clientId !== connection.clientId ||
          Boolean(pending.clientFromRegistry) !== Boolean(connection.clientFromRegistry)
        )) ||
        (pending.resource !== undefined && pending.resource !== server.auth.resource)
      ) {
        throw new ValidationError("The OAuth client or resource changed during authorization. Please connect again.");
      }
      const target = mcpTokenTarget(deps.cipher, connection, server.auth);
      const tokens = await deps.oauth.exchangeCode(target, {
        code,
        redirectUri: pending.redirectUri ?? (await redirectUri(server.auth.redirectUri)),
        codeVerifier: deps.cipher.decrypt(
          pending.codeVerifier,
          mcpOAuthStateContext(pending.state),
        ),
      });

      const now = new Date();
      const {
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        expiresAt: _expiresAt,
        ...credentials
      } = connection;
      void _accessToken, _refreshToken, _expiresAt;
      await deps.connections.put({
        ...credentials,
        // Stamped here too, so a row that predates the binding acquires both
        // halves the first time it is authorized rather than staying unbound
        // forever. `resource` is what these very tokens were minted for — the
        // RFC 8707 audience sent on the exchange just above.
        issuer: server.auth.issuer,
        resource: server.auth.resource,
        accessToken: deps.cipher.encrypt(
          tokens.accessToken,
          mcpConnectionSecretContext(
            pending.projectName,
            pending.serverName,
            "access-token",
          ),
        ),
        ...(tokens.refreshToken
          ? {
              refreshToken: deps.cipher.encrypt(
                tokens.refreshToken,
                mcpConnectionSecretContext(
                  pending.projectName,
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
        scopes: tokens.scope ? parseGrantedScopes(tokens.scope) : connection.scopes,
        status: "connected",
        connectedBy: userEmail,
        connectedAt: now.toISOString(),
        authorizationEpoch: createHash("sha256").update(pending.state).digest("hex"),
        updatedAt: now.toISOString(),
      });
      return { projectName: pending.projectName, serverName: pending.serverName };
    },

    async abandonAuthorization({ state, userEmail, error, errorDescription, iss }) {
      const pending = await deps.states.consume(state);
      if (!pending) {
        throw new ValidationError("This authorization link has expired or was already used.");
      }
      if (pending.userEmail !== userEmail) {
        throw new ForbiddenError("This authorization was started by a different user.");
      }
      // Throws on mismatch, which is what stops provider-controlled text from
      // being relayed: the caller renders its own message instead.
      assertIssuerMatches(pending, iss);
      return { error: errorDescription ?? error };
    },

    async disconnect(projectName, serverName, userEmail) {
      await assertProjectWritable(deps.projects, projectName, userEmail);
      await requireConnection(projectName, serverName);
      await deps.connections.delete(projectName, serverName);
    },

    async listTools(projectName, serverName, userEmail, headerOverrides) {
      const project = await assertProjectOwnerOrAdminReadable(deps.projects, projectName, userEmail);
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
        project.configuration?.mcpList ?? [], name => agentMcpHeadersContext(projectName, name));
      const resolvedOverrides = binding?.headers;
      // Assembled exactly as a run assembles it (see execution/mcpTools) — the
      // binding's overrides layered over the entry, then the project's
      // Authorization last so an Agent cannot substitute its own. A list built
      // any other way would be answering a question nobody asked.
      const headers = deps.cipher.mergeOutboundHeaders(
        server.headers,
        resolvedOverrides,
        mcpHeadersContext(server.name),
        agentMcpHeadersContext(projectName, serverName),
      );
      // Before the availability check below, exactly as a run strips them: a
      // stored spelling of a reserved metadata header is not "a way to
      // authenticate", and this probe must not relay one either.
      stripMcpMetadataHeaders(headers);
      if (server.auth) {
        const resolved = await deps.authProvider.headersFor(projectName, serverName, server.auth);
        if (!resolved.unavailable) {
          Object.assign(headers, resolved.headers);
        } else if (Object.keys(headers).length === 0) {
          // The same sentence a run would report, so "why are there no tools"
          // has one answer wherever it is asked. Only when there is nothing else
          // to authenticate with — an entry with headers of its own still works.
          // The consequence clause is the caller's: a run says "its tools were
          // not offered", the console says what an empty selection would mean.
          return { ok: false, error: resolved.unavailable };
        }
      }
      applyMcpUserEmail(headers, userEmail);
      const result = await deps.probe.listTools(server.url, headers, loopback);
      if (!result.ok && result.unauthorized && server.auth) {
        // What a run does with the same 401: record it, so the console offers a
        // reconnect instead of leaving the owner to re-diagnose the message.
        await deps.authProvider.markUnauthorized(projectName, serverName).catch((error: unknown) => {
          log.warn("mcp", `could not flag '${serverName}' as needing reauthorization`, error);
        });
      }
      return result;
    },
  };
}
