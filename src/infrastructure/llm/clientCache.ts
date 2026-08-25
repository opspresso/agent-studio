import { credentialCacheKey } from "@/infrastructure/credentialCacheKey";
import { BoundedCache } from "@/shared/boundedCache";

/** Runtime settings rotation can leave old SDK clients behind, so each adapter retains only this many. */
export const MAX_LLM_CLIENT_CACHE_ENTRIES = 16;

export function createLlmClientCache<T>(): BoundedCache<string, T> {
  return new BoundedCache(MAX_LLM_CLIENT_CACHE_ENTRIES);
}

export function llmClientCacheKey(...parts: readonly string[]): string {
  return credentialCacheKey(...parts);
}
