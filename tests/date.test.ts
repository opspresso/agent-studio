import { describe, expect, it } from "vitest";
import { formatDateTime, formatShortDateTime } from "@/shared/date";

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
