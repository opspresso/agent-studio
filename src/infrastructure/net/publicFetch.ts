import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import { resolvePublicUrl, SsrfError } from "./ssrfGuard";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CACHED_AGENTS = 64;

/**
 * Dispatchers keyed by `origin|pinned address`. Reusing one keeps the
 * connection pool warm — an agent run making many MCP tool calls would
 * otherwise pay a TCP+TLS handshake per call.
 *
 * This caches transport only. `resolvePublicUrl` still runs on every request
 * and every redirect hop, so a host that starts resolving to a private address
 * is rejected before a cached dispatcher is ever reached, and a host that
 * resolves to a different address gets a different key.
 */
const agentCache = new Map<string, Agent>();

function pinnedAgent(origin: string, address: string, family: 4 | 6): Agent {
  const key = `${origin}|${address}`;
  const cached = agentCache.get(key);
  if (cached) {
    return cached;
  }
  const agent = new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    },
  });
  if (agentCache.size >= MAX_CACHED_AGENTS) {
    // Map preserves insertion order: drop the oldest entry.
    const oldestKey = agentCache.keys().next().value;
    if (oldestKey !== undefined) {
      const evicted = agentCache.get(oldestKey);
      agentCache.delete(oldestKey);
      void evicted?.close();
    }
  }
  agentCache.set(key, agent);
  return agent;
}

export class PublicFetchError extends SsrfError {
  constructor(message: string) {
    super(message);
    this.name = "PublicFetchError";
  }
}

/**
 * The answer, handed back as the `Response` every caller already holds.
 *
 * `undiciFetch` returns *its package's* `Response`, which is the same web
 * standard but not the same class as the runtime's global — and one consumer
 * tells them apart: the MCP client reads an error body with
 * `input instanceof Response`, so a foreign instance would be reported as its
 * own stringified self instead of the server's message. Re-wrapping costs a
 * stream reference; `getSetCookie` is honoured because iterating headers folds
 * repeated `set-cookie` lines into one.
 */
function asGlobalResponse(response: UndiciResponse): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") {
      headers.append(name, value);
    }
  }
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(
    // One object, two declarations of it: undici types its body as
    // `node:stream/web`'s stream and the global `Response` as the DOM's, and
    // the compiler cannot see that this runtime has only ever had one of them.
    response.body as unknown as BodyInit | null,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

/**
 * Fetch an operator-controlled URL through one outbound security boundary.
 * Every hop is DNS-checked, redirects may not cross origins (which prevents
 * forwarding stored credentials to another host), and native auto-following
 * is disabled so redirect targets cannot bypass validation.
 *
 * The request goes through **undici's own `fetch`, never the global one**, and
 * that pairing is load-bearing rather than a preference: a `dispatcher` is a
 * private contract between a fetch implementation and its `Agent`, and undici
 * rewrote it between majors. The global fetch is the runtime's *bundled* undici
 * — 7.x on Node 24 — so handing it an `Agent` from the 8.x in `package.json`
 * had it build a 7-era handler that 8's dispatcher refused (`invalid
 * onRequestStart method`), surfacing as a bare `TypeError: fetch failed` on
 * every outbound request. It passed locally because a newer Node happened to
 * bundle the matching major, which is the whole problem: the pairing must not
 * depend on which Node the deployment runs.
 */
export async function fetchPublicUrl(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let url =
    input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? new URL(input.href)
        : new URL(input);
  const originalOrigin = url.origin;
  const requestBody =
    input instanceof Request && input.method !== "GET" && input.method !== "HEAD"
      ? await input.clone().arrayBuffer()
      : undefined;
  let requestInit: RequestInit = {
    ...(input instanceof Request
      ? {
          method: input.method,
          headers: input.headers,
          body: requestBody,
          signal: input.signal,
        }
      : {}),
    ...init,
    redirect: "manual",
  };

  for (let redirects = 0; ; redirects += 1) {
    const resolved = await resolvePublicUrl(url.href);
    const address = resolved.addresses[0];
    if (!address) {
      throw new PublicFetchError(`Cannot resolve host: ${url.hostname}`);
    }
    const family = address.includes(":") ? 6 : 4;
    const dispatcher = pinnedAgent(url.origin, address, family);
    const response = await undiciFetch(url, {
      ...requestInit,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    if (!REDIRECT_STATUSES.has(response.status)) {
      return asGlobalResponse(response);
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new PublicFetchError(`Too many redirects from ${originalOrigin}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      return asGlobalResponse(response);
    }
    await response.body?.cancel();
    const next = new URL(location, url);
    await resolvePublicUrl(next.href);
    if (next.origin !== originalOrigin) {
      throw new PublicFetchError(
        `Cross-origin redirect blocked: ${originalOrigin} -> ${next.origin}`,
      );
    }

    const method = (requestInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-type");
      headers.delete("content-length");
      requestInit = { ...requestInit, method: "GET", body: undefined, headers };
    }
    url = next;
  }
}
