import { describe, expect, it } from "vitest";
import { formatDateTime, formatRunClock, formatShortDateTime, isUtcDay } from "@/shared/date";

// Rendered output is locale/timezone dependent, so assert shape, not exact strings.
describe("formatShortDateTime", () => {
  it("returns empty string for empty input", () => {
    expect(formatShortDateTime("")).toBe("");
  });

  it("returns empty string for invalid input", () => {
    expect(formatShortDateTime("not-a-date")).toBe("");
  });

  it("formats a valid ISO timestamp", () => {
    const formatted = formatShortDateTime("2026-07-23T01:08:42.000Z");
    expect(formatted).not.toBe("");
    expect(formatted).toMatch(/\d/);
  });
});

describe("formatDateTime", () => {
  it("returns empty string for empty input", () => {
    expect(formatDateTime("")).toBe("");
  });

  it("returns empty string for invalid input", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });

  it("includes the year for a valid ISO timestamp", () => {
    expect(formatDateTime("2026-07-23T01:08:42.000Z")).toContain("2026");
  });
});

// Unlike the two above, this one is asserted exactly: it is UTC and en-US by
// construction, so the host's locale and timezone cannot move it.
describe("formatRunClock", () => {
  it("renders the UTC date, a spelled-out weekday, and minute precision", () => {
    expect(formatRunClock(new Date("2026-07-30T06:12:34.567Z"))).toBe(
      "2026-07-30 (Thursday) 06:12 UTC",
    );
  });

  it("moves the date and the weekday together across the UTC day boundary", () => {
    expect(formatRunClock(new Date("2026-07-30T23:59:00Z"))).toBe(
      "2026-07-30 (Thursday) 23:59 UTC",
    );
    expect(formatRunClock(new Date("2026-07-31T00:01:00Z"))).toBe("2026-07-31 (Friday) 00:01 UTC");
  });
});

describe("isUtcDay", () => {
  it("accepts a real UTC day", () => {
    expect(isUtcDay("2026-07-30")).toBe(true);
    expect(isUtcDay("2024-02-29")).toBe(true);
  });

  it("rejects a day the calendar does not have, not just a malformed one", () => {
    // The shape check alone let both of these through: 2026-13-01 parses to
    // NaN, and 2026-02-31 parses — to March 3rd.
    expect(isUtcDay("2026-13-01")).toBe(false);
    expect(isUtcDay("2026-02-31")).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isUtcDay("2026-7-1")).toBe(false);
    expect(isUtcDay("not a day")).toBe(false);
  });
});
