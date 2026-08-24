/**
 * The reading four list endpoints used to each own.
 *
 * The cases below are the three the copies disagreed about, and each of them
 * reaches a reader as a page that is wrong without looking wrong: a gallery of
 * one tile reported as the page that was asked for, or a "load more" button
 * against a list that cannot grow.
 */
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
    // `?limit=` is what a query string built from a value that turned out to be
    // absent produces. `Number("")` is 0, and clamped up it answered with a
    // single row — a gallery of one tile, reported as the page asked for.
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
    // `Math.floor(0.5)` is 0, and a zero-length page is trivially "full" — the
    // reader was offered "load more" against a list that could not grow.
    expect(parsePageLimit("0.5", { fallback: 24 })).toEqual({ wanted: 24, limit: 24 });
  });

  it("keeps what was asked for beside what may be read", () => {
    // The uncapped size is what "is there another page" is answered against;
    // comparing against the ceiling is what made the button never settle.
    expect(parsePageLimit("900", { fallback: 50, max: 500 })).toEqual({
      wanted: 900,
      limit: 500,
    });
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
    // The repositories clamp defensively, and `LIMIT NaN` used to reach the
    // store as a query error. A page of one row is the worse of the two
    // recoveries: it looks like the end of the list.
    expect(boundedPageLimit(Number.NaN)).toBe(MAX_PAGE_LIMIT);
    expect(boundedPageLimit(Number.POSITIVE_INFINITY, 500)).toBe(500);
  });
});
