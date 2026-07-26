/**
 * OAuth for registry MCP servers.
 *
 * Discovery runs once, when an admin registers or repairs a server, and stores
 * everything a run needs on the registry entry. The run path never reads a
 * well-known document: that would add two round trips and a third party's
 * availability to every time-to-first-token.
 */

import type { McpRepository } from "@/domain/mcp/repository";
import type { McpServerAuth, TokenEndpointAuthMethod } from "@/domain/mcp/types";
import type { AuthorizationServerMetadata, OAuthMetadataClient } from "@/domain/mcp/oauth";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import { NotFoundError, ValidationError } from "@/application/errors";
import { assertAllowedUrl } from "@/application/registry/registryUseCases";

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

export interface McpAuthUseCasesDeps {
  mcps: McpRepository;
  metadata: OAuthMetadataClient;
  urlPolicy: UrlPolicy;
}

export interface McpAuthUseCases {
  /**
   * Read the server's published metadata and store what an authorization needs.
   * Pass `authorizationServer` to answer a previous `choose` result.
   */
  discover(name: string, opts?: { authorizationServer?: string }): Promise<DiscoverAuthResult>;
  /** Drop the OAuth block, returning the entry to static-header behaviour. */
  clearAuth(name: string): Promise<void>;
}

export function createMcpAuthUseCases(deps: McpAuthUseCasesDeps): McpAuthUseCases {
  async function requireServer(name: string) {
    const server = await deps.mcps.get(name);
    if (!server) {
      throw new NotFoundError(`MCP server not found: ${name}`);
    }
    return server;
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
  };
}
