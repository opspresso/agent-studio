import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import { fetchSameOrigin, RedirectPolicyError, withResponseUrl } from "./redirectPolicy";
import { resolvePublicUrl, SsrfError } from "./ssrfGuard";

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

/** Close and forget pooled dispatchers between unit tests. Production never calls this. */
export function resetPublicFetchAgentCacheForTest(): void {
  for (const agent of agentCache.values()) {
    void agent.close();
  }
  agentCache.clear();
}

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
  return withResponseUrl(new Response(
    // One object, two declarations of it: undici types its body as
    // `node:stream/web`'s stream and the global `Response` as the DOM's, and
    // the compiler cannot see that this runtime has only ever had one of them.
    response.body as unknown as BodyInit | null,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  ), response.url);
}

/**
 * Fetch an outbound URL through one security boundary, including registered
 * endpoints, model-selected URLs and attachment/source addresses.
 * Every hop is DNS-checked, redirects may not cross origins (which prevents
 * forwarding stored credentials to another host), and native auto-following
 * is disabled so redirect targets cannot bypass validation.
 *
 * Use fetch and Agent from the same installed undici package: dispatcher
 * contracts can differ from the version bundled with Node's global fetch.
 */
export async function fetchPublicUrl(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchSameOrigin(input, init, async (url, requestInit) => {
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
      return asGlobalResponse(response);
    });
  } catch (error) {
    if (error instanceof RedirectPolicyError) {
      throw new PublicFetchError(error.message);
    }
    throw error;
  }
}
