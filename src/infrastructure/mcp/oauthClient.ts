/**
 * {@link OAuthClient} over `fetchPublicUrl`.
 *
 * Every request carries the RFC 8707 `resource` parameter. The MCP spec makes
 * that unconditional — "regardless of whether authorization servers support it"
 * — because it is what binds a token to one MCP server and stops a token issued
 * for one from being replayed against another.
 */

import type { OAuthClient, TokenRequestTarget, TokenSet } from "@/domain/mcp/oauth";
import { OAuthGrantError } from "@/domain/mcp/oauth";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { readBodyText } from "@/shared/httpBody";

const TOKEN_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 256_000;

/**
 * Errors that mean the grant itself is gone, so the owner must re-authorize.
 * Everything else — a 5xx, a timeout, a proxy page — is transient and must not
 * cost someone their connection.
 */
const GRANT_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_scope",
]);

function authHeaders(target: TokenRequestTarget): Record<string, string> {
  // A client with no secret has nothing to prove with, whatever the server's
  // metadata said it preferred.
  if (!target.clientSecret || target.tokenEndpointAuthMethod === "none") {
    return {};
  }
  if (target.tokenEndpointAuthMethod === "client_secret_basic") {
    const credentials = Buffer.from(
      `${encodeURIComponent(target.clientId)}:${encodeURIComponent(target.clientSecret)}`,
    ).toString("base64");
    return { Authorization: `Basic ${credentials}` };
  }
  return {};
}

function authBodyParams(target: TokenRequestTarget): Record<string, string> {
  if (!target.clientSecret || target.tokenEndpointAuthMethod !== "client_secret_post") {
    return {};
  }
  return { client_secret: target.clientSecret };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await readBodyText(response, MAX_TOKEN_RESPONSE_BYTES);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Turn a token response into a `TokenSet`, or throw.
 *
 * A non-2xx carrying an OAuth `error` code is the provider's own verdict; a
 * non-2xx without one is a transport-level failure and stays a plain Error so
 * the caller does not mark a connection dead over a bad gateway.
 */
function toTokenSet(status: number, body: Record<string, unknown>): TokenSet {
  const errorCode = asString(body.error);
  if (errorCode) {
    const description = asString(body.error_description) ?? errorCode;
    if (GRANT_ERROR_CODES.has(errorCode)) {
      throw new OAuthGrantError(errorCode, description);
    }
    throw new Error(`Token request failed (${errorCode}): ${description}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Token request failed: HTTP ${status}`);
  }
  const accessToken = asString(body.access_token);
  if (!accessToken) {
    // Slack's own endpoints answer 200 with `{"ok": false}`; a success status
    // with no token is a failure however it is dressed.
    throw new Error("Token response carried no access_token");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  const refreshToken = asString(body.refresh_token);
  const scope = asString(body.scope);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresInSeconds: expiresIn } : {}),
    ...(scope ? { scope } : {}),
  };
}

async function postForm(
  target: TokenRequestTarget,
  params: Record<string, string>,
): Promise<TokenSet> {
  const headers = authHeaders(target);
  const response = await fetchPublicUrl(target.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers,
    },
    body: new URLSearchParams({
      ...params,
      // RFC 6749 §2.3: a client must not authenticate two ways in one request.
      // With `client_secret_basic` the Authorization header already carries the
      // client's identity, and a body `client_id` beside it reads as a second
      // method — Notion's token endpoint rejects the pair outright. RFC 6749
      // §3.2.1 requires the body `client_id` only when the request is not
      // otherwise authenticated.
      ...(headers.Authorization ? {} : { client_id: target.clientId }),
      ...authBodyParams(target),
      resource: target.resource,
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  return toTokenSet(response.status, await readJson(response));
}

export const oauthClient: OAuthClient = {

  async exchangeCode(target, { code, redirectUri, codeVerifier }) {
    return postForm(target, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
  },

  async refresh(target, refreshToken) {
    return postForm(target, { grant_type: "refresh_token", refresh_token: refreshToken });
  },
};
