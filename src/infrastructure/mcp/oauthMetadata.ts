/**
 * {@link OAuthMetadataClient} over `fetchPublicUrl`, so metadata reads pass the
 * same SSRF guard every other operator-supplied URL does — with the same one
 * exception the run path and the tool probe carry, and only where the caller
 * passes it: an address this deployment vouches for is dialed with plain fetch,
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
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
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
  if (path) {
    candidates.push(`${url.origin}/.well-known/${suffix}${path}`);
  }
  candidates.push(`${url.origin}/.well-known/${suffix}`);
  return candidates;
}

async function fetchJson(url: string, loopback: boolean): Promise<Record<string, unknown> | null> {
  // Read per call rather than captured at module load, so a test that stubs the
  // global is what a loopback read talks to.
  const send = loopback ? fetch : fetchPublicUrl;
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
  parse: (doc: Record<string, unknown>) => T | null,
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
    const parsed = doc ? parse(doc) : null;
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
    return firstUsable(
      wellKnownCandidates(mcpUrl, "oauth-protected-resource"),
      (doc): ProtectedResourceMetadata | null => {
        const resource = asString(doc.resource);
        const authorizationServers = asStringArray(doc.authorization_servers);
        // Both are required by RFC 9728; a document missing either cannot drive
        // an authorization, so it is a miss rather than a partial success.
        if (!resource || !authorizationServers || authorizationServers.length === 0) {
          return null;
        }
        const scopesSupported = asStringArray(doc.scopes_supported);
        return {
          resource,
          authorizationServers,
          ...(scopesSupported ? { scopesSupported } : {}),
        };
      },
      "protected resource metadata",
      loopback,
    );
  },

  async fetchAuthorizationServer(issuer) {
    return firstUsable(
      [
        ...wellKnownCandidates(issuer, "oauth-authorization-server"),
        // Providers that only publish an OIDC document still carry the three
        // endpoints this flow needs.
        ...wellKnownCandidates(issuer, "openid-configuration"),
      ],
      (doc): AuthorizationServerMetadata | null => {
        const authorizationEndpoint = asString(doc.authorization_endpoint);
        const tokenEndpoint = asString(doc.token_endpoint);
        if (!authorizationEndpoint || !tokenEndpoint) {
          return null;
        }
        const registrationEndpoint = asString(doc.registration_endpoint);
        const tokenEndpointAuthMethodsSupported = asStringArray(
          doc.token_endpoint_auth_methods_supported,
        );
        const codeChallengeMethodsSupported = asStringArray(doc.code_challenge_methods_supported);
        const scopesSupported = asStringArray(doc.scopes_supported);
        const grantTypesSupported = asStringArray(doc.grant_types_supported);
        return {
          issuer: asString(doc.issuer) ?? issuer,
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
          ...(doc.authorization_response_iss_parameter_supported === true
            ? { issParameterSupported: true }
            : {}),
        };
      },
      "authorization server metadata",
      // Never the loopback path: see the port's note on this method.
      false,
    );
  },
};
