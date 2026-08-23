import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { MAX_SAVED_FILE_BYTES } from "@/domain/artifact/types";
import { MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";
import { MAX_ATTACHMENT_BYTES } from "@/domain/llm/imageLimits";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { getArtifactAccessMode } from "@/lib/runtime-settings";
import { proxiedObjectPath, verifyObjectUrlToken, type ObjectUrlClaims } from "./objectUrlToken";

/**
 * The store every consumer is handed: the same bytes, addressed by access mode.
 *
 * Two of the three modes are the store's own business — `public` and
 * `authenticated` differ in *which store address* a reader gets, and the S3
 * adapter answers that, anonymous-GET quirks included. `proxied` is the one
 * where the reader never gets a store address at all: the deployment's store
 * is reachable by this app and nothing else, so the address is this app's and
 * the bytes come through `/api/objects`. That decision sits above the adapter
 * because it is not about S3; a second store would want it unchanged.
 *
 * Read per call, like the adapter reads its own mode: a switch on the settings
 * page lands on the next address signed, not the next boot.
 */
export function withArtifactAccessMode(store: ArtifactObjectStore): ArtifactObjectStore {
  return {
    ...store,
    async sign(key, expiresInSeconds, options) {
      if ((await getArtifactAccessMode()) !== "proxied") {
        return store.sign(key, expiresInSeconds, options);
      }
      const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
      // An empty filename is no filename, which is how the adapter reads it too.
      const downloadAs = options?.downloadAs || undefined;
      return `${await resolvePublicBaseUrl()}${proxiedObjectPath({ key, exp, downloadAs })}`;
    },
  };
}

/**
 * The most a stored object can be, so the most a proxied read will buffer.
 *
 * Not a number picked here: an attachment is bounded by what a provider
 * accepts, a document by what its text has to fit, a saved file by the run's
 * own cap, and the store holds nothing that did not pass one of the three.
 * The adapter refuses before buffering, so a larger object is a failure that
 * says so rather than a process that ran out of memory.
 */
export const MAX_PROXIED_OBJECT_BYTES = Math.max(
  MAX_DOCUMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_SAVED_FILE_BYTES,
);

/**
 * What the route behind a proxied address needs, and nothing else: whether a
 * presented token opens its claims, and the bytes behind a key it does.
 */
export interface ProxiedObjectAccess {
  verify(claims: ObjectUrlClaims, signature: string, nowSeconds: number): boolean;
  read(key: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/**
 * Bound once at the composition root, so the route takes one object rather
 * than choosing the store and the verifier for itself — the same reason no
 * route holds `artifactStorage`.
 */
export function createProxiedObjectAccess(store: ArtifactObjectStore): ProxiedObjectAccess {
  return {
    verify: verifyObjectUrlToken,
    read: (key) => store.read(key, MAX_PROXIED_OBJECT_BYTES),
  };
}
