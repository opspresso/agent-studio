/** Shared page sizes preserve caller intent while bounding repository reads. */
import { describe, expect, it } from "vitest";
import { boundedPageLimit, MAX_PAGE_LIMIT, parsePageLimit } from "@/shared/pageLimit";

describe("parsePageLimit", () => {
  it("reads a whole page size", () => {
    expect(parsePageLimit("30", { fallback: 24 })).toEqual({ wanted: 30, limit: 30 });
  });

  it("treats an absent parameter as the default", () => {
    expect(parsePageLimit(null, { fallback: 24 })).toEqual({ wanted: 24, limit: 24 });
  });

  it("treats an empty `?limit=` as absent rather than as zero", () => {
    // Empty and whitespace-only values use the fallback before numeric coercion.
    expect(parsePageLimit("", { fallback: 24 })).toEqual({ wanted: 24, limit: 24 });
    expect(parsePageLimit("   ", { fallback: 24 })).toEqual({ wanted: 24, limit: 24 });
  });

  it("treats anything that is not a page size as absent", () => {
    for (const raw of ["abc", "-5", "0", "NaN", "Infinity"]) {
      expect(parsePageLimit(raw, { fallback: 24 }).limit).toBe(24);
    }
  });

  it("floors a fractional size rather than falling back", () => {
    expect(parsePageLimit("30.7", { fallback: 24 }).limit).toBe(30);
  });

  it("refuses to floor a fraction into an empty page", () => {
    // A fraction below one cannot produce a nonempty page.
    expect(parsePageLimit("0.5", { fallback: 24 })).toEqual({ wanted: 24, limit: 24 });
  });

  it("keeps what was asked for beside what may be read", () => {
    // Pagination compares against the requested size, including values above the cap.
    expect(parsePageLimit("900", { fallback: 50, max: 500 })).toEqual({
      wanted: 900,
      limit: 500,
    });
  });

  it("never hands back an empty page, whatever default it was given", () => {
    // Invalid defaults still yield a nonempty bounded read.
    expect(parsePageLimit(null, { fallback: 0 }).limit).toBe(1);
  });

  it("caps at the shared ceiling when the caller names none", () => {
    expect(parsePageLimit("1000", { fallback: 20 }).limit).toBe(MAX_PAGE_LIMIT);
  });
});

describe("boundedPageLimit", () => {
  it("puts a size in range", () => {
    expect(boundedPageLimit(50)).toBe(50);
    expect(boundedPageLimit(0)).toBe(1);
    expect(boundedPageLimit(-3)).toBe(1);
    expect(boundedPageLimit(1_000)).toBe(MAX_PAGE_LIMIT);
    expect(boundedPageLimit(24.9)).toBe(24);
  });

  it("honours a caller's own ceiling", () => {
    expect(boundedPageLimit(400, 500)).toBe(400);
    expect(boundedPageLimit(600, 500)).toBe(500);
  });

  it("reads an unreadable size as unstated, not as one row", () => {
    // An unspecified numeric bound uses the ceiling rather than a one-row page.
    expect(boundedPageLimit(Number.NaN)).toBe(MAX_PAGE_LIMIT);
    expect(boundedPageLimit(Number.POSITIVE_INFINITY, 500)).toBe(500);
  });
});
