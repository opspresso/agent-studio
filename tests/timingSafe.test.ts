import { describe, expect, it } from "vitest";
import { timingSafeEqualString } from "@/shared/timingSafe";

describe("timingSafeEqualString", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualString("token-secret-key", "token-secret-key")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqualString("token-secret-key", "token-secret-XXX")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(timingSafeEqualString("short", "a-much-longer-value")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(timingSafeEqualString("", "nonempty")).toBe(false);
    expect(timingSafeEqualString("nonempty", "")).toBe(false);
  });
});
