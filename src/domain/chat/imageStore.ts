/**
 * Object storage for a chat's images.
 *
 * `put` returns the object **key**, not a URL: what a reader may fetch is
 * decided when they ask rather than when the bytes are written, so a picture
 * does not outlive the chat that holds it just because someone kept a link.
 * `signUrl` is what turns a stored key back into something a browser — or a
 * provider fetching a replayed attachment — can actually GET, for as long as
 * the caller says and no longer.
 */
export interface ImageStore {
  put(image: { b64: string; mimeType: string }): Promise<string>;
  signUrl(key: string, expiresInSeconds: number): Promise<string>;
  /**
   * The key inside a URL a previous version of this app stored, or `null` when
   * the address is not this store's to sign.
   *
   * Rows written while the bucket was public-read recorded an absolute URL and
   * no key. Passing those through was correct only for as long as the bucket
   * stayed public — and making it private is the deployment step that comes
   * with the change, so every one of those images broke at exactly the moment
   * the operator followed the instructions. The address still names the object;
   * only the store knows whether the object is one of its own.
   */
  keyFromUrl(url: string): string | null;
}
