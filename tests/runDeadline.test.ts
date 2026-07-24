import { describe, expect, it, vi } from "vitest";
import { parseMaxRunDuration } from "@/lib/runDeadline";

describe("parseMaxRunDuration", () => {
  it("defaults when unset or blank", () => {
    expect(parseMaxRunDuration(undefined)).toBe(600_000);
    expect(parseMaxRunDuration("")).toBe(600_000);
    expect(parseMaxRunDuration("   ")).toBe(600_000);
  });

  it("accepts a positive, in-range integer", () => {
    expect(parseMaxRunDuration("300000")).toBe(300_000);
    expect(parseMaxRunDuration("2147483647")).toBe(2_147_483_647);
  });

  it("falls back to the default for values AbortSignal.timeout would reject", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bad of ["-1", "0", "Infinity", "NaN", "1.5", "abc", "2147483648", "9999999999999"]) {
        expect(parseMaxRunDuration(bad)).toBe(600_000);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
