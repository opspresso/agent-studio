/**
 * Reading an http(s) address, as a port.
 *
 * A port rather than a direct call because the application layer may not import
 * a fetch implementation — the same reason `DocumentExtractor` is one (it needs
 * a PDF parser) and `UrlPolicy` is one (it needs DNS). What it buys beyond the
 * rule is that the outbound boundary can be faked, so the logic above it tests
 * without a network.
 */

export interface HttpResource {
  bytes: Uint8Array;
  /** The content type, lowercased, with any parameters stripped. */
  mimeType: string;
  /** The encoding the response declared, when it declared one. */
  charset?: string;
  /** Where the bytes actually came from, after any redirects. */
  finalUrl: string;
}

/** A refusal, a non-2xx, a timeout, or a body over the cap. */
export class HttpResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpResourceError";
  }
}

export interface HttpResourceReader {
  /**
   * GET the address and return at most `maxBytes` of it.
   *
   * Never sends credentials, and never follows a redirect to another origin —
   * both because the caller of this port is a model, not an operator.
   */
  read(input: { url: string; accept: string; maxBytes: number }): Promise<HttpResource>;
}
