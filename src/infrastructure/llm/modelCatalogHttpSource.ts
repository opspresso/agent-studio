/**
 * The published model catalog, over HTTP. The URL is configuration
 * (`MODELS_CATALOG_URL`), not something a user typed, so this is a plain
 * fetch with a deadline rather than a guarded one — the guard exists for
 * addresses the operator or the model chose at runtime.
 */

import type { ModelCatalogSource } from "@/domain/llm/modelCatalogSource";

/** A static site answers in well under this; a boot must not wait longer for it. */
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 10_000;

export function createHttpModelCatalogSource(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = MODEL_CATALOG_FETCH_TIMEOUT_MS,
): ModelCatalogSource {
  return {
    description: url,
    async load() {
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
      }
      return { document: await response.json() };
    },
  };
}
