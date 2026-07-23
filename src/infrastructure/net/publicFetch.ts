import { Agent } from "undici";
import { resolvePublicUrl, SsrfError } from "./ssrfGuard";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PublicFetchError extends SsrfError {
  constructor(message: string) {
    super(message);
    this.name = "PublicFetchError";
  }
}

/**
 * Fetch an operator-controlled URL through one outbound security boundary.
 * Every hop is DNS-checked, redirects may not cross origins (which prevents
 * forwarding stored credentials to another host), and native auto-following
 * is disabled so redirect targets cannot bypass validation.
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
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, _options, callback) {
          callback(null, address, family);
        },
      },
    });
    const response = await fetch(url, {
      ...requestInit,
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    void dispatcher.close();
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new PublicFetchError(`Too many redirects from ${originalOrigin}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
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
