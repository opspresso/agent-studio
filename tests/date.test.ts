import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatRunClock,
  formatShortDateTime,
  isUtcDay,
} from "@/shared/date";

describe("formatDate", () => {
  it("keeps date-only output date-only", () => {
    expect(formatDate("2026-08-16T16:31:00", "ko-KR")).toBe("2026. 8. 16.");
  });

  it("returns empty string for invalid input", () => {
    expect(formatDate("not-a-date", "ko-KR")).toBe("");
  });
});

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

  it("uses the console's minute-precision Korean style", () => {
    expect(formatDateTime("2026-08-16T16:31:23.815", "ko-KR")).toBe(
      "2026. 8. 16. 오후 4:31",
    );
  });
});

/**
 * The locale argument is what keeps the server and the browser writing the same
 * string, and what makes a reader's chosen language decide the date format
 * rather than their browser's. Asserted through the *difference* between two
 * locales rather than against a literal, because the exact text is the
 * platform's ICU data and the timezone is the host's — neither is ours to pin.
 */
describe("the locale argument", () => {
  const iso = "2026-07-23T01:08:42.000Z";

  it("changes what `formatDateTime` writes", () => {
    expect(formatDateTime(iso, "en-US")).not.toBe(formatDateTime(iso, "ko-KR"));
  });

  it("is honoured by `formatShortDateTime` too", () => {
    // Same instant, two languages: at minimum the separators differ.
    expect(formatShortDateTime(iso, "en-US")).not.toBe(formatShortDateTime(iso, "ko-KR"));
  });

  it("is stable — the same locale twice gives the same string", () => {
    expect(formatDateTime(iso, "ko-KR")).toBe(formatDateTime(iso, "ko-KR"));
  });

  it("still refuses invalid input whatever the locale", () => {
    expect(formatDateTime("not-a-date", "ko-KR")).toBe("");
    expect(formatShortDateTime("", "en-US")).toBe("");
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
