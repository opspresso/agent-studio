/** Redirect behavior shared by guarded public fetches and declared internal fetches. */
import { SsrfError } from "./ssrfGuard";

export const MAX_OUTBOUND_REDIRECTS = 5;
export const OUTBOUND_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301,
  302,
  303,
  307,
  308,
]);

export class RedirectPolicyError extends SsrfError {
  constructor(message: string) {
    super(message);
    this.name = "RedirectPolicyError";
  }
}

/** Response wrappers otherwise discard the address of the resource they carry. */
export function withResponseUrl(response: Response, url: string): Response {
  if (response.url !== url) {
    Object.defineProperty(response, "url", { value: url, configurable: true });
  }
  return response;
}

/**
 * Follow only same-origin redirects. The caller admits the initial address;
 * public callers additionally validate and pin DNS inside `send` on every hop.
 */
export async function fetchSameOrigin(
  input: string | URL | Request,
  init?: RequestInit,
  send: (url: URL, init: RequestInit) => Promise<Response> = (url, options) => fetch(url, options),
): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : input);
  const originalOrigin = url.origin;
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  if (input instanceof Request) {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    requestInit = {
      ...requestInit,
      method: request.method,
      headers: request.headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    };
  }

  for (let redirects = 0; ; redirects += 1) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new RedirectPolicyError("Only HTTP(S) URLs without embedded credentials are allowed");
    }
    requestInit.signal?.throwIfAborted();
    const response = await send(url, requestInit);
    const location = response.headers.get("location");
    if (!OUTBOUND_REDIRECT_STATUSES.has(response.status) || !location) {
      return withResponseUrl(response, response.url || url.href);
    }
    await response.body?.cancel().catch(() => {});
    if (redirects >= MAX_OUTBOUND_REDIRECTS) {
      throw new RedirectPolicyError(`Too many redirects from ${originalOrigin}`);
    }
    const next = new URL(location, url);
    if (next.origin !== originalOrigin) {
      throw new RedirectPolicyError(
        `Cross-origin redirect blocked: ${originalOrigin} -> ${next.origin}`,
      );
    }
    const method = (requestInit.method ?? "GET").toUpperCase();
    if (
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "GET" && method !== "HEAD")
    ) {
      const headers = new Headers(requestInit.headers);
      for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
        headers.delete(name);
      }
      requestInit = { ...requestInit, method: "GET", body: undefined, headers };
    }
    url = next;
  }
}
