import { describe, expect, it } from "vitest";
import { textLines, widthOf } from "@/infrastructure/documents/engine/write/pptx/layout";

describe("slide text width estimation", () => {
  it("keeps Hangul, Han, Kana and compatibility ideographs at full width", () => {
    expect(widthOf("가中あ\uf900")).toBe(4);
  });

  it.each(["\ua4d0", "\ue000"])("does not extend the CJK range over %s", character => {
    expect(widthOf(character)).toBe(0.5);
    const text = character.repeat(90);
    expect(textLines({ kind: "text", runs: [{ text }], style: { size: 1800, indent: 0 } }))
      .toEqual([[{ text }]]);
  });
});
