import { describe, expect, it } from "vitest";

/**
 * PostgreSQL's jsonb refuses `\\u0000`, which is what the function exists to
 * keep out — without touching a string that merely spells it. The in-memory
 * store the unit tests run on applies the same rule, so a test reads back what
 * the database would have kept rather than what the caller wrote.
 */
const { toStoredJson } = await import("@/infrastructure/db/storedJson");
const { createFakeStore } = await import("./fakeStore");

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

  it("is what the fake store keeps, so a test sees the database's copy", async () => {
    const store = createFakeStore();
    await store.putItem({ PK: "P", SK: "S", text: "a\u0000b", half: "\ud83d" });
    expect(await store.getItem({ PK: "P", SK: "S" })).toEqual({
      PK: "P",
      SK: "S",
      text: "a\uFFFDb",
      half: "\uFFFD",
    });
  });
});
