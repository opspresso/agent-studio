import { createHash } from "node:crypto";

/** Build a stable cache key without retaining credential text in the key itself. */
export function credentialCacheKey(...parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
