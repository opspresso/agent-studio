import { isSourceFileObjectKey } from "./sourceFile";

/**
 * Where an artifact's bytes are kept.
 *
 * Writing and signing share one port because they must be wired together:
 * storing a key nobody can sign is the same as storing nothing. One interface
 * makes that requirement structural.
 *
 * The port takes a key rather than minting one: {@link artifactObjectKey} owns
 * the naming, so the adapter knows nothing about how objects are addressed.
 */

/**
 * A readable GET address for a stored object.
 *
 * The lifetime belongs to the reader, because the readers differ: a chat view is
 * read by a person with the page already open, while durable messaging records
 * need a link that remains useful after the run has ended.
 *
 * The adapter may return a time-limited signed URL or a direct public URL.
 * `downloadAs` sets the filename a browser saves under, and asking for one is
 * also what makes an address time-limited even where the deployment serves
 * objects publicly: a filename rides on the request's signature, so there is no
 * such thing as a permanent URL that carries one.
 */
export type SignObjectUrl = (
  key: string,
  expiresInSeconds: number,
  options?: { downloadAs?: string },
) => Promise<string>;

/**
 * What `read` rejects with for a key the store holds nothing under.
 *
 * Named here so a caller can answer "not there" rather than "failed" without
 * knowing the adapter's own error names — the proxied object route turns this
 * into a 404 and everything else into a 500.
 */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No stored object at ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

/** Private file keys require their owner/retention checks, never a reusable object URL. */
export function assertNotPrivateFileKey(key: string): void {
  if (isSourceFileObjectKey(key)) throw new ObjectNotFoundError(key);
}

export interface ArtifactObjectStore {
  put(input: { key: string; bytes: Uint8Array; mimeType: string }): Promise<void>;
  /**
   * Read an object without allowing the adapter to buffer past the caller's
   * cap. Rejects with {@link ObjectNotFoundError} when there is no such key.
   */
  read(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
  sign: SignObjectUrl;
  /**
   * Remove an object. Succeeds when the key is already gone, which is what lets
   * a half-finished delete be retried: the row is removed only after this
   * resolves, so a retry always converges rather than failing on the second try.
   */
  delete(key: string): Promise<void>;
}
