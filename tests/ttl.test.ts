import { afterEach, describe, expect, it } from "vitest";
import { expiresAtSeconds, isExpired, RETENTION } from "@/infrastructure/db/ttl";

const DAY = 86_400;

describe("expiresAtSeconds", () => {
  it("is retentionDays after the base timestamp, in unix seconds", () => {
    const base = "2026-01-01T00:00:00Z";
    const baseSec = Date.parse(base) / 1000;
    expect(expiresAtSeconds(base, 30)).toBe(baseSec + 30 * DAY);
  });

  it("is deterministic for the same base and retention (index co-expiry)", () => {
    const base = "2026-03-15T12:34:56Z";
    expect(expiresAtSeconds(base, 180)).toBe(expiresAtSeconds(base, 180));
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");

  it("is true once the TTL is at or before now", () => {
    expect(isExpired(Math.floor(now / 1000), now)).toBe(true);
    expect(isExpired(Math.floor(now / 1000) - 1, now)).toBe(true);
  });

  it("is false for a future TTL", () => {
    expect(isExpired(Math.floor(now / 1000) + DAY, now)).toBe(false);
  });

  it("never expires a row without an expiresAt", () => {
    expect(isExpired(undefined, now)).toBe(false);
    expect(isExpired("nope", now)).toBe(false);
  });
});

describe("RETENTION", () => {
  afterEach(() => {
    delete process.env.TRACE_RETENTION_DAYS;
  });

  it("uses safe defaults (usage kept past the 184-day dashboard window)", () => {
    expect(RETENTION.traceDays).toBe(30);
    expect(RETENTION.usageDays).toBeGreaterThan(184);
    expect(RETENTION.chatDays).toBe(180);
  });

  it("honors a positive env override", () => {
    process.env.TRACE_RETENTION_DAYS = "7";
    expect(RETENTION.traceDays).toBe(7);
  });

  it("ignores a non-positive or invalid override", () => {
    process.env.TRACE_RETENTION_DAYS = "0";
    expect(RETENTION.traceDays).toBe(30);
    process.env.TRACE_RETENTION_DAYS = "nope";
    expect(RETENTION.traceDays).toBe(30);
  });
});
