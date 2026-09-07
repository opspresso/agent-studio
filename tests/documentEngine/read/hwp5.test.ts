/**
 * The two layers inside an HWP body that decide what the document says: the
 * record walk, and the control-character accounting inside a paragraph.
 *
 * The accounting is the one worth the most attention. HWP stores objects,
 * fields and section definitions *inside* the text as control characters, and
 * the extended ones occupy eight UTF-16 units rather than one. A miscount does
 * not lose a character and does not throw — it shifts the rest of the paragraph
 * and returns noise that still looks like text, which nothing downstream can
 * detect.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { decodeParaText, paragraphsOf, sectionsOf, HwpError } from "@/infrastructure/documents/engine/read/hwp5";

const HWPTAG_PARA_HEADER = 0x010 + 50;
const HWPTAG_PARA_TEXT = 0x010 + 51;

/** UTF-16LE bytes for a list of code units. */
function units(...codes: number[]): Uint8Array {
  const out = new Uint8Array(codes.length * 2);
  const view = new DataView(out.buffer);
  codes.forEach((code, index) => view.setUint16(index * 2, code, true));
  return out;
}

function chars(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

/** A control that occupies eight units: the character, six of data, the character again. */
function control(code: number): number[] {
  return [code, 0, 0, 0, 0, 0, 0, code];
}

function record(tag: number, payload: Uint8Array): Uint8Array {
  const long = payload.byteLength >= 0xfff;
  const size = long ? 0xfff : payload.byteLength;
  const head = new Uint8Array(long ? 8 : 4);
  const view = new DataView(head.buffer);
  // tag in the low 10 bits, level in the next 10, size in the top 12.
  view.setUint32(0, (tag & 0x3ff) | (0 << 10) | (size << 20), true);
  if (long) {
    view.setUint32(4, payload.byteLength, true);
  }
  return Buffer.concat([head, payload]);
}

test("ordinary characters come through as themselves", () => {
  assert.equal(decodeParaText(units(...chars("한글 문서"))), "한글 문서");
});

test("a paragraph end and a forced line break are newlines, and take one unit", () => {
  assert.equal(decodeParaText(units(...chars("가"), 10, ...chars("나"), 13)), "가\n나\n");
});

test("the fixed-width spaces and the hyphen are the characters they stand for", () => {
  assert.equal(decodeParaText(units(...chars("a"), 30, ...chars("b"), 31, ...chars("c"), 24)), "a b c-");
});

test("an extended control takes eight units and contributes nothing", () => {
  // Code 11 is a drawing object or a table. Its six units of data are arbitrary
  // — here they are text, which is exactly the case a miscount turns into
  // output that looks like the document.
  const payload = units(...chars("앞"), 11, ...chars("XXXXXX"), 11, ...chars("뒤"));
  assert.equal(decodeParaText(payload), "앞뒤");
});

test("a tab is a tab, and still takes eight units", () => {
  // The one control that is both: it contributes a character *and* is an inline
  // control with data after it.
  const payload = units(...chars("a"), ...control(9), ...chars("b"));
  assert.equal(decodeParaText(payload), "a\tb");
});

test("a control at the very end does not read past the payload", () => {
  assert.equal(decodeParaText(units(...chars("끝"), 3)), "끝");
  assert.equal(decodeParaText(units(...chars("끝"), 3, 0, 0)), "끝");
});

test("an odd trailing byte is ignored rather than read as half a character", () => {
  const payload = Buffer.concat([units(...chars("ab")), Uint8Array.from([0x41])]);
  assert.equal(decodeParaText(payload), "ab");
});

test("only the text records contribute, and each is one paragraph", () => {
  const section = Buffer.concat([
    record(HWPTAG_PARA_HEADER, units(0, 0, 0, 0)),
    record(HWPTAG_PARA_TEXT, units(...chars("첫 문단"))),
    record(HWPTAG_PARA_HEADER, units(0, 0, 0, 0)),
    record(HWPTAG_PARA_TEXT, units(...chars("둘째 문단"))),
  ]);
  assert.deepEqual(paragraphsOf(section), ["첫 문단", "둘째 문단"]);
});

test("a paragraph past 4,095 bytes carries its size in the following word", () => {
  // Ordinary rather than exceptional: prose passes that at about two thousand
  // characters, so a reader that ignored the escape would lose every long
  // paragraph in the document.
  const long = "가".repeat(3000);
  const section = record(HWPTAG_PARA_TEXT, units(...chars(long)));
  assert.deepEqual(paragraphsOf(section), [long]);
});

test("a truncated record is refused instead of reporting a complete partial body", () => {
  const good = record(HWPTAG_PARA_TEXT, units(...chars("kept")));
  const truncated = record(HWPTAG_PARA_TEXT, units(...chars("lost"))).subarray(0, 6);
  assert.throws(() => paragraphsOf(Buffer.concat([good, truncated])), HwpError);
  assert.throws(() => paragraphsOf(Buffer.concat([good, Uint8Array.from([1, 2])])), HwpError);
  const extended = new Uint8Array(4);
  new DataView(extended.buffer).setUint32(0, 0xfff00043, true);
  assert.throws(() => paragraphsOf(extended), HwpError);
});

test("an empty section yields nothing rather than throwing", () => {
  assert.deepEqual(paragraphsOf(new Uint8Array(0)), []);
  assert.throws(() => paragraphsOf(Uint8Array.from([1, 2])), HwpError);
});

test("sections are ordered by their number, not by their name", () => {
  const paths = [
    "BodyText/Section10",
    "BodyText/Section2",
    "BodyText/Section0",
    "DocInfo",
    "FileHeader",
    "ViewText/Section0",
  ];
  assert.deepEqual(sectionsOf(paths), [
    "BodyText/Section0",
    "BodyText/Section2",
    "BodyText/Section10",
  ]);
});
