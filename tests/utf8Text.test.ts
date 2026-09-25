import { describe, expect, it } from "vitest";
import { cutCodePoints, cutUtf8Bytes, decodeUtf8Text } from "@/shared/utf8Text";

/**
 * The decision this exists for: `Buffer.toString("utf-8")` never fails, so the
 * naive decode reports binary as content. Everything below is about telling
 * "this is text" apart from "this decoded without throwing", which are not the
 * same question.
 */
describe("decodeUtf8Text", () => {
  it("returns the text when the bytes are text", () => {
    expect(decodeUtf8Text(Buffer.from("hello", "utf-8"))).toBe("hello");
  });

  it("keeps multi-byte text intact", () => {
    expect(decodeUtf8Text(Buffer.from("제목 · 本文 · emoji 🎉", "utf-8"))).toBe(
      "제목 · 本文 · emoji 🎉",
    );
  });

  it("refuses bytes that are not UTF-8, where a plain decode would not", () => {
    // A PDF header. `toString("utf-8")` turns this into "%PDF-1.4\n%????" and
    // reports success, which is how a document reached a model as a page of
    // replacement characters.
    const pdf = Buffer.from("255044462d312e340a25e2e3cfd3", "hex");
    expect(pdf.toString("utf-8")).toContain("�");
    expect(decodeUtf8Text(pdf)).toBeNull();
  });

  it("refuses a lone continuation byte", () => {
    expect(decodeUtf8Text(Buffer.from([0x80]))).toBeNull();
  });

  it("refuses a truncated multi-byte sequence", () => {
    const cut = Buffer.from("한", "utf-8").subarray(0, 2);
    expect(decodeUtf8Text(cut)).toBeNull();
  });

  it("refuses ASCII UTF-16, which validity alone would let through", () => {
    // "hi" in UTF-16LE is `68 00 69 00` — perfectly valid UTF-8 that decodes to
    // "h\0i\0" with no replacement character anywhere. Validity does not settle
    // this one; the NUL does.
    const utf16 = Buffer.from("hi", "utf16le");
    expect(Buffer.from(utf16.toString("utf-8"), "utf-8").equals(utf16)).toBe(true);
    expect(decodeUtf8Text(utf16)).toBeNull();
  });

  it("refuses any text carrying a NUL, the long-standing binary signal", () => {
    expect(decodeUtf8Text(Buffer.from("before\u0000after", "utf-8"))).toBeNull();
  });

  it("reads empty bytes as the empty string, not as a refusal", () => {
    // "Nothing in it" and "cannot be read" are different answers, and callers
    // report them differently.
    expect(decodeUtf8Text(Buffer.alloc(0))).toBe("");
  });

  it("drops a byte-order mark, which is encoding and not content", () => {
    expect(decodeUtf8Text(Buffer.from("﻿name,value", "utf-8"))).toBe("name,value");
  });

  it("reads a view into a larger buffer, not the whole buffer", () => {
    // Node pools small allocations, so a Uint8Array handed here is often a
    // window onto memory that holds other things.
    const backing = Buffer.from("XXXhelloYYY", "utf-8");
    expect(decodeUtf8Text(backing.subarray(3, 8))).toBe("hello");
  });
});

/**
 * `slice` on a JS string cuts UTF-16 units, so truncating user text at an
 * arbitrary index can land between the halves of a non-BMP character. What comes
 * back is then not well-formed text: PostgreSQL JSONB will not store it, and
 * it reaches a provider as a lone surrogate escape.
 */
describe("cutCodePoints", () => {
  it("returns the text untouched when it already fits", () => {
    expect(cutCodePoints("hello", 10)).toBe("hello");
    expect(cutCodePoints("hello", 5)).toBe("hello");
  });

  it("keeps the cut well-formed when it would split a surrogate pair", () => {
    const text = "a".repeat(9) + "\u{1F600}";
    // The naive cut is what this exists to avoid.
    expect(text.slice(0, 10).isWellFormed()).toBe(false);

    const cut = cutCodePoints(text, 10);
    expect(cut).toBe("a".repeat(9));
    expect(cut.isWellFormed()).toBe(true);
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
  });

  it("keeps a whole character that ends exactly at the limit", () => {
    const text = "a".repeat(8) + "\u{1F600}" + "b";
    expect(cutCodePoints(text, 10)).toBe("a".repeat(8) + "\u{1F600}");
  });

  it("leaves multi-byte characters that are not surrogate pairs alone", () => {
    expect(cutCodePoints("한국어입니다", 3)).toBe("한국어");
  });

  it("survives a zero limit", () => {
    expect(cutCodePoints("\u{1F600}", 0)).toBe("");
  });
});

describe("cutUtf8Bytes", () => {
  it("returns text under the budget unchanged", () => {
    expect(cutUtf8Bytes("hello", 5)).toBe("hello");
  });

  it("cuts ASCII exactly at the budget", () => {
    expect(cutUtf8Bytes("abcdef", 4)).toBe("abcd");
  });

  it("backs off instead of cutting through a two-byte character", () => {
    // "é" is 2 bytes; a budget of 2 lands between its bytes.
    const cut = cutUtf8Bytes("aé", 2);
    expect(cut).toBe("a");
    expect(cut.isWellFormed()).toBe(true);
  });

  it("backs off instead of cutting through a four-byte character", () => {
    const text = "ab\u{1F600}";
    for (const budget of [3, 4, 5]) {
      const cut = cutUtf8Bytes(text, budget);
      expect(cut).toBe("ab");
      // The whole point: no U+FFFD is manufactured at the boundary.
      expect(cut.includes("�")).toBe(false);
    }
    expect(cutUtf8Bytes(text, 6)).toBe(text);
  });

  it("keeps a multi-byte character that ends exactly at the budget", () => {
    expect(cutUtf8Bytes("한국", 3)).toBe("한");
    expect(cutUtf8Bytes("한국", 6)).toBe("한국");
  });

  it("survives a zero budget", () => {
    expect(cutUtf8Bytes("\u{1F600}", 0)).toBe("");
  });
});
