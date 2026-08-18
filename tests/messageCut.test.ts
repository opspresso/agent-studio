import { describe, expect, it } from "vitest";
import { cutPoint, splitMessages } from "@/shared/messageCut";

/**
 * Where a reply is cut when it outgrows one message. Everything here is about
 * the one thing a reader sees: a message that stops in the middle of a sentence
 * and continues in the next reads as broken, however complete the text is.
 */
describe("cutPoint", () => {
  it("keeps the whole text when it fits", () => {
    expect(cutPoint("short", 0, 100, 20)).toBe(5);
  });

  it("prefers a paragraph break over a line break", () => {
    const text = `${"a".repeat(40)}\n\n${"b".repeat(10)}\n${"c".repeat(60)}`;
    // The line break is nearer the cap; the paragraph is the larger structure
    // and is still inside the window.
    expect(cutPoint(text, 0, 60, 50)).toBe(42);
  });

  it("falls back to a line break", () => {
    const text = `${"a".repeat(40)}\n${"b".repeat(60)}`;
    expect(cutPoint(text, 0, 60, 50)).toBe(41);
  });

  it("falls back to a sentence end", () => {
    const text = `${"a".repeat(38)}. ${"b".repeat(60)}`;
    expect(cutPoint(text, 0, 60, 50)).toBe(40);
  });

  it("falls back to a space", () => {
    const text = `${"a".repeat(40)} ${"b".repeat(60)}`;
    expect(cutPoint(text, 0, 60, 50)).toBe(41);
  });

  it("cuts at the cap when the window holds no boundary at all", () => {
    expect(cutPoint("a".repeat(100), 0, 60, 50)).toBe(60);
  });

  it("never splits a surrogate pair", () => {
    // The cap lands between the two halves of the last emoji.
    const text = `${"a".repeat(58)}${"🙂".repeat(10)}`;
    expect(cutPoint(text, 0, 59, 0)).toBe(58);
  });

  it("looks no further back than the message it is cutting", () => {
    // A window wider than what this message holds must not reach into the
    // message before it and return a cut that goes backwards.
    const text = `${"a".repeat(20)}\n${"b".repeat(200)}`;
    expect(cutPoint(text, 100, 50, 500)).toBe(150);
  });
});

describe("splitMessages", () => {
  it("returns one piece when the answer fits", () => {
    expect(splitMessages("just this", { room: 100, window: 20 })).toEqual([
      { text: "just this", end: 9, prefix: "" },
    ]);
  });

  it("loses nothing across the cuts", () => {
    const text = Array.from({ length: 20 }, (_, index) => `paragraph ${index} ${"x".repeat(40)}`).join(
      "\n\n",
    );
    const pieces = splitMessages(text, { room: 200, window: 60 });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((piece) => piece.text).join("")).toBe(text);
    expect(pieces.at(-1)?.end).toBe(text.length);
  });

  it("closes a code fence it cut through and reopens it with the same language", () => {
    const text = `here:\n\n\`\`\`python\n${"print(1)\n".repeat(40)}\`\`\`\n`;
    const pieces = splitMessages(text, { room: 200, window: 60 });

    expect(pieces.length).toBeGreaterThan(2);
    // Every piece is a balanced block on its own.
    for (const piece of pieces) {
      expect(piece.text.split("```").length % 2).toBe(1);
    }
    expect(pieces[1]?.text.startsWith("```python\n")).toBe(true);
    expect(pieces[0]?.text.endsWith("```")).toBe(true);
    // The reopened fence is the only text the pieces add.
    const rebuilt = pieces
      .map((piece) => piece.text.slice(piece.prefix.length))
      .join("")
      .replaceAll("\n```", "");
    expect(rebuilt).toBe(text.replaceAll("\n```", ""));
  });

  it("continues a fence the caller was already inside", () => {
    const [first] = splitMessages("still code\n", { room: 100, window: 20, prefix: "```ts\n" });
    expect(first?.text).toBe("```ts\nstill code\n");
    // `end` indexes the answer, not the fence put in front of it.
    expect(first?.end).toBe(11);
  });

  it("leaves room for the closing fence inside the cap", () => {
    const text = `\`\`\`\n${"line\n".repeat(40)}`;
    for (const piece of splitMessages(text, { room: 60, window: 20 })) {
      expect(piece.text.length).toBeLessThanOrEqual(60);
    }
  });
});
