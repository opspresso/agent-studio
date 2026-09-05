/**
 * {@link OAuthMetadataClient} over `fetchPublicUrl`, so metadata reads pass the
 * same SSRF guard every other operator-supplied URL does — with the same one
 * exception the run path and the tool probe carry, and only where the caller
 * passes it: an address this deployment vouches for skips public address resolution,
 * because the guard would reject it on every request and the entry would be
 * registrable and dispatchable but never discoverable.
 *
 * Only used at registration. The run path reads the stored `McpServerAuth`
 * instead: fetching two well-known documents per run would add a third party's
 * availability to every time-to-first-token.
 */

import type {
  AuthorizationServerMetadata,
  OAuthMetadataClient,
  ProtectedResourceMetadata,
} from "@/domain/mcp/oauth";
import { McpMetadataError } from "@/domain/mcp/oauth";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/client";
import { LEGACY_PROTOCOL_VERSION, MCP_CLIENT_INFO } from "./session";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { fetchSameOrigin } from "@/infrastructure/net/redirectPolicy";
import { readBodyText } from "@/shared/httpBody";

const METADATA_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 256_000;

/**
 * Well-known URIs to try, in order. The path-inserted form comes first: a host
 * serving several MCP endpoints distinguishes them by path, and taking the
 * origin form first would silently read another endpoint's document.
 */
export function wellKnownCandidates(base: string, suffix: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates: string[] = [];
  if (path || url.search) {
    candidates.push(`${url.origin}/.well-known/${suffix}${path}${url.search}`);
  }
  candidates.push(`${url.origin}/.well-known/${suffix}`);
  return candidates;
}

/**
 * The authorization server's metadata addresses, in the order the spec
 * requires a client to try them (2026-07-28, authorization-server-discovery):
 * for an issuer with a path, RFC 8414 path-inserted, then OpenID path-inserted,
 * then OpenID path-appended; for a bare origin, the two root forms. Never the
 * root form for a path issuer — the document there belongs to another issuer,
 * and reading it was how a Keycloak realm or an Okta custom authorization
 * server silently bound to the wrong one.
 */
export function authorizationServerCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** RFC 8414 requires a code-point-for-code-point match with the requested issuer. */
function sameIssuer(a: string, b: string): boolean {
  return a === b;
}

/**
 * Where the server itself says its resource metadata is.
 *
 * RFC 9728 lets a server publish the document at any address and name it in
 * the `WWW-Authenticate` challenge of a 401. A server that only names it —
 * one whose metadata sits behind a gateway path — was undiscoverable while
 * only the well-known paths were tried. MCP makes this address authoritative
 * when present, so the probe precedes constructed well-known fallbacks. It is
 * the request a legacy client would make first anyway: an `initialize`.
 */
async function challengedMetadataUrl(mcpUrl: string, loopback: boolean): Promise<string | undefined> {
  const send = loopback ? fetchSameOrigin : fetchPublicUrl;
  try {
    const response = await send(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          // The legacy revision on purpose: a 2025-era server answers it, and
          // a modern one answers a 401 to either.
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        },
      }),
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 401) {
      return undefined;
    }
    const { resourceMetadataUrl } = extractWWWAuthenticateParams(response);
    if (!resourceMetadataUrl) {
      return undefined;
    }
    // A declared-internal server is dialed past the guard, and this address is
    // the server's own choice: past the guard it may name anything on the
    // network. Same origin as the server is what the bypass was granted for.
    if (loopback && resourceMetadataUrl.origin !== new URL(mcpUrl).origin) {
      return undefined;
    }
    return resourceMetadataUrl.href;
  } catch {
    // The well-known paths are still there to try; a probe that failed says
    // nothing about them.
    return undefined;
  }
}

async function fetchJson(url: string, loopback: boolean): Promise<Record<string, unknown> | null> {
  // Read per call rather than captured at module load, so a test that stubs the
  // global is what a loopback read talks to.
  const send = loopback ? fetchSameOrigin : fetchPublicUrl;
  const response = await send(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const text = await readBodyText(response, MAX_METADATA_BYTES);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A login page served with a 200 is not metadata; treat it as a miss and
    // let the next candidate answer rather than failing the whole discovery.
    return null;
  }
}

async function firstUsable<T>(
  candidates: string[],
  parse: (doc: Record<string, unknown>, url: string) => T | null,
  what: string,
  loopback: boolean,
): Promise<T> {
  const failures: string[] = [];
  for (const url of candidates) {
    let doc: Record<string, unknown> | null = null;
    try {
      doc = await fetchJson(url, loopback);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = doc ? parse(doc, url) : null;
    if (parsed) {
      return parsed;
    }
    failures.push(`${url}: no usable ${what}`);
  }
  // Typed, not bare: every reason collected above is about the server or the
  // network, and the caller needs to be able to say so with a status.
  throw new McpMetadataError(`Could not read ${what}. Tried ${failures.join("; ")}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

export const oauthMetadataClient: OAuthMetadataClient = {
  async fetchProtectedResource(mcpUrl, loopback = false) {
    const wellKnown = wellKnownCandidates(mcpUrl, "oauth-protected-resource");
    // MCP makes the challenge authoritative when it is present; constructed
    // well-known paths are the fallback only. Reversing that order can bind a
    // client to a generic gateway document while the MCP resource names its
    // tenant-specific metadata in the 401.
    const challenged = await challengedMetadataUrl(mcpUrl, loopback);
    if (challenged) {
      return firstUsable(
        [challenged],
        (doc) => parseProtectedResource(doc, mcpUrl),
        "protected resource metadata",
        loopback,
      );
    }
    const endpoint = new URL(mcpUrl);
    const endpointPath = endpoint.pathname.replace(/\/+$/, "");
    const endpointResource = `${endpoint.origin}${endpointPath}${endpoint.search}`;
    return firstUsable(
      wellKnown,
      (doc, url) =>
        parseProtectedResource(
          doc,
          url === `${endpoint.origin}/.well-known/oauth-protected-resource`
            ? endpoint.origin
            : endpointResource,
        ),
      "protected resource metadata",
      loopback,
    );
  },

  async fetchAuthorizationServer(issuer) {
    return firstUsable(
      authorizationServerCandidates(issuer),
      parseAuthorizationServer(issuer),
      "authorization server metadata",
      // Never the loopback path: see the port's note on this method.
      false,
    );
  },
};

const parseProtectedResource = (
  doc: Record<string, unknown>,
  expectedResource: string,
): ProtectedResourceMetadata | null => {
  const resource = asString(doc.resource);
  const authorizationServers = asStringArray(doc.authorization_servers);
  // MCP requires the authorization server list. RFC 9728 §3.3 additionally
  // forbids using a document whose resource is not the exact identifier from
  // which its well-known URL was derived, or the URL that issued a challenge.
  if (
    resource !== expectedResource ||
    !authorizationServers ||
    authorizationServers.length === 0
  ) {
    return null;
  }
  const scopesSupported = asStringArray(doc.scopes_supported);
  return {
    resource,
    authorizationServers,
    ...(scopesSupported ? { scopesSupported } : {}),
  };
};

const parseAuthorizationServer =
  (issuer: string) =>
  (doc: Record<string, unknown>): AuthorizationServerMetadata | null => {
    const authorizationEndpoint = asString(doc.authorization_endpoint);
    const tokenEndpoint = asString(doc.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) {
      return null;
    }
    // RFC 8414 §3.3 / OpenID Discovery §4.3: a document whose `issuer` is
    // not the one it was fetched for MUST NOT be used. One that names none
    // cannot be checked and is treated the same way — the next candidate
    // may be the right document, and a wrong one bound here is a wrong
    // server for every authorization that follows.
    const declaredIssuer = asString(doc.issuer);
    if (!declaredIssuer || !sameIssuer(declaredIssuer, issuer)) {
      return null;
    }
    const registrationEndpoint = asString(doc.registration_endpoint);
    const tokenEndpointAuthMethodsSupported = asStringArray(doc.token_endpoint_auth_methods_supported);
    const codeChallengeMethodsSupported = asStringArray(doc.code_challenge_methods_supported);
    const scopesSupported = asStringArray(doc.scopes_supported);
    const grantTypesSupported = asStringArray(doc.grant_types_supported);
    return {
      issuer: declaredIssuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(tokenEndpointAuthMethodsSupported ? { tokenEndpointAuthMethodsSupported } : {}),
      ...(codeChallengeMethodsSupported ? { codeChallengeMethodsSupported } : {}),
      ...(scopesSupported ? { scopesSupported } : {}),
      ...(grantTypesSupported ? { grantTypesSupported } : {}),
      // Only `true` counts. RFC 9207 §2.3 makes this the signal that a
      // response *without* `iss` must be rejected, so anything that is not
      // an explicit boolean true leaves that rejection switched off.
      ...(doc.authorization_response_iss_parameter_supported === true ? { issParameterSupported: true } : {}),
      // Read at registration like everything else here, so the run path
      // never pays for it. A server that adds support later is picked up
      // when an admin re-runs discovery — the same moment every other
      // endpoint on this document would move.
      ...(doc.client_id_metadata_document_supported === true ? { clientIdMetadataDocumentSupported: true } : {}),
    };
  };
