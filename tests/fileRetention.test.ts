import { describe, expect, it } from "vitest";
import { fileExpiresAt } from "@/application/artifact/fileRetention";
import type { FileRetention } from "@/domain/artifact/retention";

describe("calendar file retention", () => {
  it.each([
    ["2026-11-30T10:00:00+09:00", "2027-02-28T01:00:00.000Z"],
    ["2023-11-30T10:00:00+09:00", "2024-02-29T01:00:00.000Z"],
    ["2026-01-31T23:59:59.123+09:00", "2026-04-30T14:59:59.123Z"],
    ["2026-09-08T10:00:00+09:00", "2026-12-08T01:00:00.000Z"],
  ])("adds three calendar months to %s", (storedAt, expected) => {
    expect(fileExpiresAt(storedAt, { unit: "months", value: 3, timezone: "Asia/Seoul" })).toBe(expected);
  });

  it("uses the configured timezone rather than the timestamp's offset", () => {
    expect(fileExpiresAt("2026-01-31T23:30:00Z", { unit: "months", value: 1, timezone: "Asia/Seoul" }))
      .toBe("2026-02-28T23:30:00.000Z");
  });

  it("preserves local time across DST without assuming a day has 24 hours", () => {
    expect(fileExpiresAt("2026-03-07T12:00:00-05:00", { unit: "days", value: 1, timezone: "America/New_York" }))
      .toBe("2026-03-08T16:00:00.000Z");
  });

  it("moves a nonexistent wall time forward through the spring gap", () => {
    expect(fileExpiresAt("2026-03-07T02:30:00-05:00", { unit: "days", value: 1, timezone: "America/New_York" }))
      .toBe("2026-03-08T07:30:00.000Z");
  });

  it("chooses the earlier instant in a repeated wall time", () => {
    expect(fileExpiresAt("2026-10-31T01:30:00-04:00", { unit: "days", value: 1, timezone: "America/New_York" }))
      .toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles a timezone that skipped a whole calendar day", () => {
    expect(fileExpiresAt("2011-12-29T12:00:00-10:00", { unit: "days", value: 1, timezone: "Pacific/Apia" }))
      .toBe("2011-12-30T22:00:00.000Z");
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid or overflowing durations %s", (value) => {
    expect(() => fileExpiresAt("2026-09-08T00:00:00Z", { unit: "months", value, timezone: "UTC" })).toThrow();
  });

  it.each([
    "invalid", "2026-09-08", "2026-09-08T00:00:00", "2026-99-99T00:00:00Z",
    "2026-02-30T00:00:00Z", "2026-09-08T24:00:00Z", "0000-01-01T00:00:00Z",
  ])("rejects ambiguous instants %s", (storedAt) => {
    expect(() => fileExpiresAt(storedAt, { unit: "days", value: 1, timezone: "UTC" })).toThrow();
  });

  it.each(["", "not/a/timezone"])("rejects invalid timezone %s", (timezone) => {
    expect(() => fileExpiresAt("2026-09-08T00:00:00Z", { unit: "days", value: 1, timezone })).toThrow();
  });

  it("rejects an unsupported duration unit", () => {
    expect(() => fileExpiresAt("2026-09-08T00:00:00Z", {
      unit: "years", value: 1, timezone: "UTC",
    } as unknown as FileRetention)).toThrow();
  });
});
