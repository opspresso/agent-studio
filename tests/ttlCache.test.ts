/**
 * The two bounds, and why both are needed.
 *
 * The TTL is the one anybody writes. The entry cap is the one that was missing
 * from the per-workspace settings cache, where the key comes off an
 * unauthenticated request header — and a TTL never evicts the entry nobody
 * looks up again, because expiry only runs on lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtlCache } from "@/shared/ttlCache";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-03T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("time", () => {
  it("serves a value until its TTL and not after", () => {
    const cache = createTtlCache<string>({ ttlMs: 1_000, maxEntries: 10 });
    cache.set("a", "one");
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe("one");
    vi.advanceTimersByTime(2);
    expect(cache.get("a")).toBeUndefined();
  });

  it("keeps null as a value, distinct from a miss", () => {
    // Both callers cache "the row does not exist", which has to survive as an
    // answer rather than become a re-read on every request.
    const cache = createTtlCache<string | null>({ ttlMs: 1_000, maxEntries: 10 });
    cache.set("a", null);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("size", () => {
  it("never grows past the cap, however many keys a caller invents", () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 100; i += 1) {
      cache.set(`tenant-${i}`, i);
    }
    expect(cache.size).toBe(3);
    expect(cache.get("tenant-0")).toBeUndefined();
    expect(cache.get("tenant-99")).toBe(99);
  });

  it("evicts the oldest write, and a re-write counts as new", () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    // Without the delete-before-set, `a` would stay at the front of the
    // insertion order and be evicted despite being the one just refreshed.
    cache.set("a", "3");
    cache.set("c", "4");
    expect(cache.get("a")).toBe("3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("4");
  });

  it("drops everything on clear", () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 10 });
    cache.set("a", 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});
