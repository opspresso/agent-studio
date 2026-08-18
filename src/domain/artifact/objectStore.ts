/**
 * Where an artifact's bytes are kept.
 *
 * One port rather than the two this replaced. Writing used to be an application
 * type and signing a domain one, wired separately and held together by a comment
 * on the composition site saying "both or neither" — because storing a key
 * nobody can sign is the same as storing nothing. One interface makes that
 * structural.
 *
 * The port takes a key rather than minting one: {@link artifactObjectKey} owns
 * the naming, so the adapter knows nothing about how objects are addressed.
 */

/**
 * A readable GET address for a stored object.
 *
 * The lifetime belongs to the reader, because the readers differ: a chat view is
 * read by a person with the page already open, while a replay hands the URL to a
 * model provider that fetches it at some point inside a run.
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

export interface ArtifactObjectStore {
  put(input: { key: string; bytes: Uint8Array; mimeType: string }): Promise<void>;
  /** Read an object without allowing the adapter to buffer past the caller's cap. */
  read(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
  sign: SignObjectUrl;
  /**
   * Remove an object. Succeeds when the key is already gone, which is what lets
   * a half-finished delete be retried: the row is removed only after this
   * resolves, so a retry always converges rather than failing on the second try.
   */
  delete(key: string): Promise<void>;
}
