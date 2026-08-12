/**
 * {@link HttpResourceReader} over the outbound boundary.
 *
 * **This is the only place an address the *model* chose is fetched.** Every
 * other caller of `fetchPublicUrl` passes a URL an operator registered, where
 * the guard is the second of two controls — the registration check is the first,
 * and `docs/SECURITY.md` says as much. Here there is no first control, so the
 * rules below are load-bearing rather than defence in depth:
 *
 * - **The internal-host exemption is never consulted.** `skipsUrlGuard` exists so
 *   this app can reach its own cluster MCP services; honouring it here would let
 *   one prompt injection read `http://mcp-argocd.agent-mcps.svc.cluster.local/`.
 *   `tests/architecture.test.ts` fails if this file so much as imports it.
 * - **Nothing authenticates.** No tenant header, no MCP OAuth token, no Slack
 *   token, no caller headers forwarded. Always GET, never a body.
 * - **Refusals are generalised on the way out.** `PublicFetchError` names the
 *   host it refused, and handing that to a model turns this into an oracle for
 *   which internal names exist. The detail goes to the log; the caller gets a
 *   sentence that says nothing about the network's shape.
 */

import {
  HttpResourceError,
  type HttpResource,
  type HttpResourceReader,
} from "@/domain/net/httpResource";
import { fetchPublicUrl } from "@/infrastructure/net/publicFetch";
import { SsrfError } from "@/infrastructure/net/ssrfGuard";
import { log } from "@/shared/logger";

/** Long enough for a slow site, short enough not to hold a turn open. */
const FETCH_TIMEOUT_MS = 15_000;

// A fixed string rather than the app version: this is sent to third parties on
// a model's say-so, and there is no reason to tell them which build asked.
const USER_AGENT = "agentdure (+https://github.com/opspresso/agentdure)";

/** `text/html; charset=EUC-KR` → `{ mimeType: "text/html", charset: "euc-kr" }`. */
export function parseContentType(header: string | null): { mimeType: string; charset?: string } {
  const [type = "", ...parameters] = (header ?? "").split(";");
  const charset = parameters
    .map((parameter) => /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(parameter)?.[1])
    .find((value): value is string => value !== undefined);
  return {
    mimeType: type.trim().toLowerCase(),
    ...(charset ? { charset: charset.trim().toLowerCase() } : {}),
  };
}

/**
 * The charset declared *inside* an HTML document.
 *
 * Plenty of servers send `text/html` with no charset and let the document say
 * so — still common on Korean sites, where guessing UTF-8 turns the whole page
 * into replacement characters. Only the head is scanned, and as latin1, because
 * the declaration is ASCII in every encoding this could be.
 */
export function charsetFromHtml(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const match =
    /<meta[^>]+charset\s*=\s*["']?([a-z0-9_\-]+)/i.exec(head) ??
    /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_\-]+)/i.exec(head);
  return match?.[1]?.toLowerCase();
}

/**
 * Read at most `maxBytes`, cutting the stream rather than measuring afterwards.
 *
 * The declared length is checked first and separately: a `content-length` that
 * lies must not decide how much is pulled into memory, and a body with no
 * declared length at all must still be bounded.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpResourceError(
      `it is ${declared.toLocaleString("en-US")} bytes, over the ${maxBytes.toLocaleString("en-US")} limit`,
    );
  }
  const body = response.body;
  if (!body) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      // Destructured on purpose. Reading the flag off a named result object
      // instead would look, to the single-owner check, exactly like this file
      // deciding why a *run* ended — which is a question it has no part in.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new HttpResourceError(
          `it is larger than the ${maxBytes.toLocaleString("en-US")} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releasing the lock lets the connection be reused; cancelling an
    // already-finished body is a no-op.
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** Just the origin. A URL is often itself the credential — a signed query, a
 * webhook path — so the whole thing has no business in a log line. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable)";
  }
}

export const httpResourceReader: HttpResourceReader = {
  async read({ url, accept, maxBytes }): Promise<HttpResource> {
    let response: Response;
    try {
      response = await fetchPublicUrl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // The only two headers. Nothing here identifies this deployment's
        // tenants or carries any stored credential.
        headers: { Accept: accept, "User-Agent": USER_AGENT },
      });
    } catch (error) {
      if (error instanceof SsrfError) {
        // The reason names a host or an address, which is exactly what must not
        // reach a model that may have been talked into asking.
        log.warn("fetch", `refused ${originOf(url)}`, error.message);
        throw new HttpResourceError("that address is not reachable from here");
      }
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      log.warn("fetch", `failed ${originOf(url)}`, error);
      throw new HttpResourceError(
        timedOut ? "the request timed out" : "the request failed",
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpResourceError(`the server answered ${response.status}`);
    }

    const bytes = await readCapped(response, maxBytes);
    const { mimeType, charset } = parseContentType(response.headers.get("content-type"));
    // The header wins; the document's own declaration is the fallback, which is
    // what a browser does and what Korean sites in particular rely on.
    const declared = charset ?? charsetFromHtml(bytes);
    return {
      bytes,
      mimeType,
      ...(declared ? { charset: declared } : {}),
      finalUrl: response.url || url,
    };
  },
};
