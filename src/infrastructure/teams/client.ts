/** Minimal Bot Framework (Microsoft Teams) client over fetch — no SDK dependency. */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import type {
  TeamsClientPort,
  TeamsCredentials,
  TeamsOutboundActivity,
} from "@/domain/teams/client";
import { credentialCacheKey } from "@/infrastructure/credentialCacheKey";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { BoundedCache } from "@/shared/boundedCache";
import { readBodyBytes } from "@/shared/httpBody";

/** A signing key as the JWKS document lists it. */
type SigningKey = JsonWebKey & { kid?: string; endorsements?: string[] };

/**
 * How long any one call may take. A Teams run's work happens in `after()`,
 * past the response, so a hung call has nothing above it to give up; the run's
 * own deadline covers the model and the tools, not the reply.
 */
const TEAMS_TIMEOUT_MS = 30_000;
/** Bytes move here, so the same ceiling would cut a large attachment short. */
const TEAMS_TRANSFER_TIMEOUT_MS = 120_000;
/** Where a token for the app is minted; the tenant is `botframework.com` for a multi-tenant app. */
const TOKEN_HOST = "https://login.microsoftonline.com";
const TOKEN_SCOPE = "https://api.botframework.com/.default";
/**
 * Where the Bot Framework publishes the keys it signs deliveries with, and
 * the issuer those tokens carry. The Emulator signs with other keys and is
 * deliberately not accepted: this endpoint answers the real service.
 */
const OPENID_CONFIGURATION = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUERS = new Set(["https://api.botframework.com"]);
/** How long the signing keys are kept before being fetched again. */
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
/** Skew a token's `nbf`/`exp` are allowed against this clock. */
const CLOCK_SKEW_SECONDS = 5 * 60;
/** How far ahead of expiry a cached app token is dropped. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
/** Rotated bot credentials cannot make process memory grow without bound. */
const MAX_TOKEN_CACHE_ENTRIES = 32;

function teamsFetch(url: string, init: RequestInit = {}, timeoutMs = TEAMS_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * The token cache, dropped a minute before a token expires. Keyed by the whole
 * credential — app, tenant, and a hash of the secret — not the app alone: a
 * rotated or mistyped secret must fetch, not read the token the old one
 * earned, or the console's *Test connection* answers "works" for an hour
 * after the credentials stopped working.
 */
const tokens = new BoundedCache<string, { token: string; expiresAt: number }>(
  MAX_TOKEN_CACHE_ENTRIES,
);

function credentialKey(credentials: TeamsCredentials): string {
  return credentialCacheKey(
    credentials.appId,
    credentials.tenantId ?? "",
    credentials.appPassword,
  );
}

async function appToken(credentials: TeamsCredentials): Promise<{ token: string; expiresInSeconds: number }> {
  const key = credentialKey(credentials);
  const cached = tokens.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { token: cached.token, expiresInSeconds: Math.floor((cached.expiresAt - now) / 1000) };
  }
  if (cached) {
    tokens.delete(key);
  }
  const tenant = credentials.tenantId ?? "botframework.com";
  const res = await teamsFetch(`${TOKEN_HOST}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.appId,
      client_secret: credentials.appPassword,
      scope: TOKEN_SCOPE,
    }),
  });
  let data: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`Teams token request failed: HTTP ${res.status}`);
  }
  if (!res.ok || !data.access_token) {
    // The description names the cause (a wrong secret, an unknown app) and
    // never the secret itself.
    throw new Error(`Teams token request failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`);
  }
  const expiresInSeconds = data.expires_in ?? 3600;
  tokens.set(key, {
    token: data.access_token,
    expiresAt: now + (expiresInSeconds - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000,
  });
  return { token: data.access_token, expiresInSeconds };
}

/** The Bot Framework's signing keys, by `kid`, fetched once a day. */
let signingKeys: { fetchedAt: number; keys: Map<string, SigningKey> } | undefined;
/** The fetch in flight, so N tokens arriving on a rotation cost one round trip, not N. */
let signingKeysFetch: Promise<void> | undefined;
/**
 * How soon after a fetch an unknown `kid` may cause another. The service
 * rotates keys rarely; an unknown kid arriving faster than this is a token
 * nobody signed, and it must not be able to make this process hammer the key
 * endpoint — every claim below is checked before the signature, and all of
 * them can be typed by hand.
 */
const KEYS_REFETCH_MIN_MS = 60_000;

async function fetchSigningKeys(): Promise<void> {
  const configuration = (await (await teamsFetch(OPENID_CONFIGURATION)).json()) as { jwks_uri?: string };
  if (!configuration.jwks_uri) {
    throw new Error("Bot Framework OpenID configuration names no jwks_uri");
  }
  const jwks = (await (await teamsFetch(configuration.jwks_uri)).json()) as { keys?: SigningKey[] };
  signingKeys = {
    fetchedAt: Date.now(),
    keys: new Map((jwks.keys ?? []).filter((key) => key.kid).map((key) => [key.kid as string, key])),
  };
}

async function keyFor(kid: string): Promise<SigningKey | undefined> {
  const now = Date.now();
  const stale = !signingKeys || now - signingKeys.fetchedAt > KEYS_TTL_MS;
  // Refetched on a miss too — the service rotates keys, and a token signed
  // with a key this process has not seen is the ordinary case after one — but
  // not more often than the floor, and once for everyone waiting.
  const missed = signingKeys !== undefined && !signingKeys.keys.has(kid) && now - signingKeys.fetchedAt > KEYS_REFETCH_MIN_MS;
  if (stale || missed) {
    signingKeysFetch ??= fetchSigningKeys().finally(() => {
      signingKeysFetch = undefined;
    });
    await signingKeysFetch;
  }
  return signingKeys?.keys.get(kid);
}

function base64UrlJson<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as T;
}

/**
 * Verify a Bot Framework bearer token: RS256 over the service's published
 * key, issued by the service, for this app, still valid, and for the
 * `serviceUrl` the activity claims — the last one is what keeps a token
 * captured from one conversation from vouching for another address.
 */
async function verifyBearer(
  authorization: string | null,
  expected: { appId: string; serviceUrl: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return { ok: false, reason: "no bearer token" };
  }
  const [rawHeader, rawPayload, rawSignature] = token.split(".");
  if (!rawHeader || !rawPayload || !rawSignature) {
    return { ok: false, reason: "not a JWT" };
  }
  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; serviceurl?: string };
  try {
    header = base64UrlJson(rawHeader);
    payload = base64UrlJson(rawPayload);
  } catch {
    return { ok: false, reason: "malformed JWT" };
  }
  if (header.alg !== "RS256" || !header.kid) {
    return { ok: false, reason: `unsupported algorithm ${header.alg ?? "none"}` };
  }
  if (!payload.iss || !ISSUERS.has(payload.iss)) {
    return { ok: false, reason: `issuer ${payload.iss ?? "missing"}` };
  }
  // A GUID either way, compared as one: the registration is stored as typed
  // and the service writes it lower-case.
  const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map((aud) =>
    (aud ?? "").toLowerCase(),
  );
  if (!audiences.includes(expected.appId.toLowerCase())) {
    return { ok: false, reason: "audience is another app" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp === undefined || payload.exp + CLOCK_SKEW_SECONDS < now) {
    return { ok: false, reason: "expired" };
  }
  if (payload.nbf !== undefined && payload.nbf - CLOCK_SKEW_SECONDS > now) {
    return { ok: false, reason: "not yet valid" };
  }
  if (!payload.serviceurl || normalizeServiceUrl(payload.serviceurl) !== normalizeServiceUrl(expected.serviceUrl)) {
    return { ok: false, reason: "issued for another serviceUrl" };
  }
  let key: SigningKey | undefined;
  try {
    key = await keyFor(header.kid);
  } catch (error) {
    return { ok: false, reason: `signing keys unavailable: ${error instanceof Error ? error.message : "unknown"}` };
  }
  if (!key) {
    return { ok: false, reason: "unknown signing key" };
  }
  try {
    const verified = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${rawHeader}.${rawPayload}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(rawSignature, "base64url"),
    );
    return verified ? { ok: true } : { ok: false, reason: "signature does not verify" };
  } catch (error) {
    return { ok: false, reason: `signature check failed: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

function normalizeServiceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** The Bot Framework REST envelope for a failure, when it sends one. */
async function readError(res: Response, what: string): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) {
      detail = `${body.error.code ?? res.status}: ${body.error.message}`;
    }
  } catch {
    // The status is all there is.
  }
  return new Error(`Teams ${what} failed: ${detail}`);
}

async function activitiesUrl(serviceUrl: string, conversationId: string, activityId?: string): Promise<string> {
  const base = `${normalizeServiceUrl(serviceUrl)}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
  return activityId ? `${base}/${encodeURIComponent(activityId)}` : base;
}

export const teamsClient: TeamsClientPort = {
  verifyRequest: verifyBearer,

  async authenticate(credentials) {
    const { expiresInSeconds } = await appToken(credentials);
    return { expiresInSeconds };
  },

  async sendActivity(credentials, serviceUrl, conversationId, activity) {
    const { token } = await appToken(credentials);
    const res = await teamsFetch(await activitiesUrl(serviceUrl, conversationId), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(outbound(activity)),
    });
    if (!res.ok) {
      throw await readError(res, "sendActivity");
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: data.id ?? "" };
  },

  async updateActivity(credentials, serviceUrl, conversationId, activityId, activity) {
    const { token } = await appToken(credentials);
    const res = await teamsFetch(await activitiesUrl(serviceUrl, conversationId, activityId), {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...outbound(activity), id: activityId }),
    });
    if (!res.ok) {
      throw await readError(res, "updateActivity");
    }
  },

  /**
   * An attachment address is untrusted input from the activity, and it is
   * treated as one twice over. The bot's token goes only to the conversation's
   * own service host — the one the verified token vouched for — because a
   * token sent to a host the activity names is a token handed to whoever named
   * it. Every other address (a file shared in a chat comes with a
   * pre-authenticated one on another host) is fetched through the SSRF guard,
   * like any address this platform did not choose: an activity that names an
   * internal address must not have it read from inside the network and handed
   * to the model.
   */
  async downloadAttachment(credentials, serviceUrl, url, maxBytes) {
    let attachmentUrl: URL;
    try {
      attachmentUrl = new URL(url);
    } catch {
      throw new Error("Teams attachment url is not a URL");
    }
    const serviceOrigin = (() => {
      try {
        const parsed = new URL(serviceUrl);
        return parsed.protocol === "https:" ? parsed.origin : "";
      } catch {
        return "";
      }
    })();
    const res =
      attachmentUrl.protocol === "https:" && attachmentUrl.origin === serviceOrigin
        ? await teamsFetch(
            url,
            { headers: { Authorization: `Bearer ${(await appToken(credentials)).token}` } },
            TEAMS_TRANSFER_TIMEOUT_MS,
          )
        : await fetchPublicUrl(url, { signal: AbortSignal.timeout(TEAMS_TRANSFER_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Teams attachment download failed: ${res.status}`);
    }
    return Buffer.from(await readBodyBytes(res, maxBytes));
  },
};

/** The Bot Framework's spelling of what this platform sends. */
function outbound(activity: TeamsOutboundActivity): Record<string, unknown> {
  return {
    type: activity.type,
    ...(activity.text !== undefined ? { text: activity.text, textFormat: "markdown" } : {}),
    ...(activity.replyToId ? { replyToId: activity.replyToId } : {}),
    ...(activity.attachments ? { attachments: activity.attachments } : {}),
  };
}

/** For tests: forget cached tokens and keys. */
export function clearTeamsCaches(): void {
  tokens.clear();
  signingKeys = undefined;
  signingKeysFetch = undefined;
}
