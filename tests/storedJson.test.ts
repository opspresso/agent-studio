import { describe, expect, it, vi } from "vitest";

/**
 * `tests/setup.ts` replaces the item store with the in-memory fake; the
 * serialiser under test is the real one, so it is taken from the actual
 * module. PostgreSQL's jsonb refuses `\\u0000`, which is what the function
 * exists to keep out — without touching a string that merely spells it.
 */
const { toStoredJson } =
  await vi.importActual<typeof import("@/infrastructure/db/store")>("@/infrastructure/db/store");

describe("toStoredJson", () => {
  it("replaces a NUL character with U+FFFD", () => {
    const stored = toStoredJson({ PK: "P", SK: "S", text: "a\u0000b" });
    expect(stored).not.toContain("\\u0000");
    expect(JSON.parse(stored).text).toBe("a\uFFFDb");
  });

  it("leaves a string that spells the escape intact and parseable", () => {
    const literal = "\\u0000"; // six characters: backslash, u, 0, 0, 0, 0
    const stored = toStoredJson({ PK: "P", SK: "S", text: literal });
    expect(JSON.parse(stored).text).toBe(literal);
  });

  it("tells the two apart when a backslash precedes the NUL", () => {
    const stored = toStoredJson({ PK: "P", SK: "S", text: "\\\u0000" });
    expect(JSON.parse(stored).text).toBe("\\\uFFFD");
  });

  it("replaces a lone surrogate, and only a lone one", () => {
    const stored = toStoredJson({ PK: "P", SK: "S", text: "🙂 \ud83d", title: "🙂" });
    const parsed = JSON.parse(stored);
    expect(parsed.text).toBe("🙂 \uFFFD");
    expect(parsed.title).toBe("🙂");
  });
});
