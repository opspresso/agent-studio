import { describe, expect, it } from "vitest";

import { credentialCacheKey } from "@/infrastructure/credentialCacheKey";
import {
  createLlmClientCache,
  MAX_LLM_CLIENT_CACHE_ENTRIES,
} from "@/infrastructure/llm/clientCache";
import { BoundedCache } from "@/shared/boundedCache";

describe("BoundedCache", () => {
  it("evicts the least-recently-used entry", () => {
    const cache = new BoundedCache<string, number>(2);
    cache.set("first", 1);
    cache.set("second", 2);

    expect(cache.get("first")).toBe(1);
    cache.set("third", 3);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(1);
    expect(cache.get("third")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("rejects a cache with no usable capacity", () => {
    expect(() => new BoundedCache(0)).toThrow("positive integer");
  });

  it("applies the LLM client retention limit", () => {
    const cache = createLlmClientCache<number>();
    for (let index = 0; index <= MAX_LLM_CLIENT_CACHE_ENTRIES; index += 1) {
      cache.set(String(index), index);
    }

    expect(cache.size).toBe(MAX_LLM_CLIENT_CACHE_ENTRIES);
    expect(cache.get("0")).toBeUndefined();
  });
});

describe("credentialCacheKey", () => {
  it("is stable and retains none of the credential text", () => {
    const key = credentialCacheKey("https://provider.example/v1", "app-id", "secret-value");

    expect(key).toBe(
      credentialCacheKey("https://provider.example/v1", "app-id", "secret-value"),
    );
    expect(key).not.toContain("provider.example");
    expect(key).not.toContain("app-id");
    expect(key).not.toContain("secret-value");
  });

  it("preserves component boundaries", () => {
    expect(credentialCacheKey("a", "bc")).not.toBe(credentialCacheKey("ab", "c"));
  });
});
