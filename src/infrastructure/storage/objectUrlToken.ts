/**
 * The token a proxied object URL carries, and the URL it is carried in.
 *
 * In `proxied` access mode the store is reachable by this app and nothing
 * else — a MinIO inside the network, say — so a reader is handed this app's
 * address rather than the store's, and the app answers with the bytes. The
 * address has to be usable by whoever holds it without a session, because
 * its holders are an `<img>` tag, a Slack message, and a model provider
 * fetching a replayed image mid-run; so the address *is* the credential, the
 * way a pre-signed S3 URL is. What it proves is that this deployment minted
 * it for this key, with this lifetime and this filename.
 *
 * ```
 * GET {publicBaseUrl}/api/objects/artifacts/image/<uuid>.png?exp=<unix>&sig=<hmac>[&dl=<filename>]
 * ```
 *
 * The signature is an HMAC-SHA256 over the key, the expiry and the filename
 * together, under a key derived from `AES_ENCRYPTION_KEY` by HKDF — a
 * deployment already has to keep that secret and rotate it knowingly, so a
 * second secret would be a second thing to rotate with no second property
 * gained. The derivation keeps the two uses apart: the bytes that sign a URL
 * are never the bytes that encrypt a stored token.
 *
 * The filename is bound, not decorative: a download link is signed *as* a
 * download and cannot be turned into an inline view by dropping `dl`, which
 * is the same guarantee `ResponseContentDisposition` gives inside a
 * pre-signed S3 request.
 */

import { createHmac, hkdfSync } from "node:crypto";
import { config } from "@/lib/config";
import { timingSafeEqualString } from "@/shared/timingSafe";

export interface ObjectUrlClaims {
  /** The object key, exactly as stored. */
  key: string;
  /** Unix seconds after which the address no longer answers. */
  exp: number;
  /** The filename a browser saves under; absent means rendered inline. */
  downloadAs?: string;
}

/** Where the route that answers these lives; the signer and the route agree here. */
export const OBJECTS_PATH = "/api/objects";

/** Domain separation from every other use of the master key. */
const SIGNING_KEY_INFO = "agent-studio/object-url/v1";
const SIGNING_KEY_BYTES = 32;

/**
 * Derived once. In `proxied` mode every stored object a reader sees is signed
 * here and verified here again, so the derivation is on the request path of
 * every image the console draws; the master key is read at boot and never
 * changes within a process.
 */
let derived: Buffer | undefined;

function signingKey(): Buffer {
  if (!derived) {
    const master = Buffer.from(config.aesEncryptionKey, "base64");
    derived = Buffer.from(hkdfSync("sha256", master, "", SIGNING_KEY_INFO, SIGNING_KEY_BYTES));
  }
  return derived;
}

/**
 * The message is a JSON array rather than `key|exp|filename`: a filename may
 * contain whatever separator was chosen, and a signature over an ambiguous
 * encoding is a signature over more than one message.
 */
export function objectUrlSignature(claims: ObjectUrlClaims): string {
  const message = JSON.stringify([claims.key, claims.exp, claims.downloadAs ?? null]);
  return createHmac("sha256", signingKey()).update(message).digest("base64url");
}

/**
 * Whether a presented token opens these claims now. Expiry is checked first
 * and the signature in constant time; both failures are one answer, because
 * telling them apart tells a forger which half to fix.
 */
export function verifyObjectUrlToken(
  claims: ObjectUrlClaims,
  signature: string,
  nowSeconds: number,
): boolean {
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds) {
    return false;
  }
  return timingSafeEqualString(objectUrlSignature(claims), signature);
}

/**
 * The path and query of a proxied object URL, to go after the deployment's
 * public base. Each key segment is encoded on its own so the route — a
 * catch-all, which decodes per segment — reads back the exact key.
 */
export function proxiedObjectPath(claims: ObjectUrlClaims): string {
  const encodedKey = claims.key.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({
    exp: String(claims.exp),
    sig: objectUrlSignature(claims),
  });
  if (claims.downloadAs !== undefined) {
    query.set("dl", claims.downloadAs);
  }
  return `${OBJECTS_PATH}/${encodedKey}?${query.toString()}`;
}
