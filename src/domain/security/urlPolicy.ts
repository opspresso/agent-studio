/**
 * Port for deciding whether an operator-registered URL may be dispatched to.
 *
 * The concrete policy performs DNS resolution, so application code that called
 * it directly could not run without a resolver. Keeping it behind a port also
 * keeps `SsrfError` — an infrastructure type — out of the application layer.
 */

/**
 * A URL the policy refuses. Carries the reason so callers can surface it; each
 * call site decides whether that becomes a thrown error, a tool result, or a
 * run warning.
 */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export interface UrlPolicy {
  /**
   * Resolve `url` and reject it when it is not a public http(s) target.
   *
   * @throws {BlockedUrlError} when the URL is disallowed. Other failures (a
   * resolver fault, say) propagate unchanged, so a caller can tell "refused"
   * apart from "could not decide".
   */
  assertAllowed(url: string): Promise<void>;
}
