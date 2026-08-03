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
}
