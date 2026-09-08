/**
 * The RTF reader, which exists for a failure mode the others do not have.
 *
 * RTF is a text file, so without this it is not refused — it is *read as plain
 * text* and reaches the model as thousands of control words with the prose
 * scattered through them. Every case below is one of the ways that garbage gets
 * in: a font table's contents, a generator's version string, an escape left
 * unresolved.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { rtfToBlocks, rtfToText, RtfError } from "@/infrastructure/documents/engine/read/rtf";

const rtf = (body: string) => new TextEncoder().encode(`{\\rtf1\\ansi${body}}`);
/** Latin-1, which is what a writer emitting `\\'hh` produced. */
const latin1 = (source: string) => new Uint8Array(Buffer.from(source, "latin1"));

test("prose comes back without its control words", () => {
  assert.equal(rtfToText(rtf("\\pard Hello world.\\par")).text, "Hello world.");
});

test("a font table's contents stay out of the text", () => {
  // The defect a naive control-word strip produces: "Times New Roman" in the
  // middle of somebody's letter.
  const bytes = rtf("{\\fonttbl{\\f0\\froman Times New Roman;}}\\pard Body text.\\par");
  const { text } = rtfToText(bytes);
  assert.equal(text, "Body text.");
  assert.doesNotMatch(text, /Times/);
});

test("an ignorable destination is skipped whole, whatever it is named", () => {
  const bytes = rtf("{\\*\\generator Riched20 10.0;}\\pard Real content.\\par");
  const { text } = rtfToText(bytes);
  assert.equal(text, "Real content.");
  assert.doesNotMatch(text, /Riched20/);
});

test("a colour table and a stylesheet are destinations too", () => {
  const bytes = rtf(
    "{\\colortbl;\\red0\\green0\\blue0;}{\\stylesheet{\\s0 Normal;}}\\pard Text.\\par",
  );
  assert.equal(rtfToText(bytes).text, "Text.");
});

test("a hex escape becomes its character", () => {
  // Windows-1252 é, which is what `\\'e9` means in an `\\ansi` document.
  assert.equal(rtfToText(latin1("{\\rtf1\\ansi caf\\'e9\\par}")).text, "café");
});

test("a unicode escape wins over the fallback that follows it", () => {
  // `\\u54620?` is 한 with `?` as the substitute for readers that cannot show it.
  const { text } = rtfToText(rtf("\\pard \\u54620?\\u44544?\\par"));
  assert.equal(text, "한글");
  assert.doesNotMatch(text, /\?/);
});

test("Unicode fallback lengths are scoped and stop at group boundaries", () => {
  assert.equal(rtfToText(rtf("\\uc1 {\\uc0\\u65}\\u66?tail")).text, "ABtail");
  assert.equal(rtfToText(rtf("\\uc1\\u65{\\b B}C")).text, "A**B**C");
  assert.equal(rtfToText(rtf("\\uc1\\u65\\b plain")).text, "Aplain");
  assert.equal(rtfToText(rtf("\\uc1\\u65\\-tail")).text, "Atail");
  assert.equal(rtfToText(rtf("\\uc1\\u65\\bin3 xyztail")).text, "Atail");
});

test("binary payload bytes cannot close a skipped picture group", () => {
  const text = rtfToText(rtf("\\pard{\\pict\\bin3 " + "}\\{" + "}kept\\par")).text;
  assert.equal(text, "![image]()\n\nkept");
  assert.throws(() => rtfToText(rtf("\\pard{\\pict\\bin100 x}")), /binary data/);
  assert.equal(rtfToText(rtf("{\\annotation{\\*\\shppict{\\pict ff}}}body")).text, "body");
});

test("a negative unicode code point is the signed 16-bit form", () => {
  // Writers emit negative numbers for anything past U+7FFF; -11384 is 54152.
  assert.equal(rtfToText(rtf("\\pard \\u-11384?\\par")).text, String.fromCodePoint(54152));
});

test("escaped braces and backslashes are literal", () => {
  // The backslash is escaped on the way out, so it reads back as one rather
  // than as the start of an escape.
  assert.equal(rtfToText(rtf("\\pard a \\{b\\} \\\\c\\par")).text, "a {b} \\\\c");
});

test("control symbols preserve their visible characters", () => {
  assert.equal(rtfToText(rtf("\\pard one\\~two\\_three\\-four\\par")).text, "one two-threefour");
});

test("unknown control words cannot resolve inherited object properties", () => {
  assert.equal(rtfToText(rtf("\\pard before\\constructor after\\par")).text, "beforeafter");
});

test("paragraphs and tabs become the lines and columns they are", () => {
  const { text } = rtfToText(rtf("\\pard one\\par two\\line three\\par name\\tab value\\par"));
  assert.equal(text, "one\n\ntwo\n\nthree\n\nname\tvalue");
});

test("table cells are separated the way every other reader separates them", () => {
  assert.match(rtfToText(rtf("\\pard A\\cell B\\cell\\row")).text, /A \| B/);
});

test("a file that does not begin with the header is refused", () => {
  assert.throws(() => rtfToText(new TextEncoder().encode("just text")), RtfError);
});

test("a document with only markup is refused rather than returned empty", () => {
  assert.throws(() => rtfToText(rtf("{\\fonttbl{\\f0 Arial;}}")), RtfError);
});

test("a heading ends where `\\pard` says it does", () => {
  // Reading `\outlinelevel` without honouring `\pard` is how one heading turns
  // every paragraph after it into a heading — the likeliest way this change
  // ships broken, because nothing errors.
  const text = rtfToText(rtf("\\pard\\outlinelevel0 Title\\par \\pard Body\\par")).text;
  assert.equal(text, "# Title\n\nBody");
});

test("an outline level past six is clamped, and a negative one is nothing", () => {
  assert.equal(rtfToText(rtf("\\pard\\outlinelevel8 deep\\par")).text, "###### deep");
  assert.equal(rtfToText(rtf("\\pard\\outlinelevel-1 plain\\par")).text, "plain");
});

test("the marker the writer drew is the list it drew", () => {
  // `{\listtext …}` leaked into the prose as a stray bullet before. Captured,
  // it answers ordered-versus-bullet without touching `\listtable` at all.
  const bulleted = rtfToText(rtf("\\pard{\\listtext\\'b7\\tab}one\\par\\pard{\\listtext\\'b7\\tab}two\\par")).text;
  assert.equal(bulleted, "- one\n- two");
  const numbered = rtfToText(rtf("\\pard{\\listtext 1.\\tab}one\\par\\pard{\\listtext 2.\\tab}two\\par")).text;
  assert.equal(numbered, "1. one\n2. two");
  // The marker itself never reaches the text.
  assert.doesNotMatch(bulleted, /·|·/);
});

test("emphasis ends where its group does", () => {
  // `{` saves the character formatting and `}` restores it. A flag rather than
  // a stack leaves the rest of the document bold.
  const blocks = rtfToBlocks(rtf("\\pard {\\b bold}plain\\par")).blocks;
  assert.deepEqual(blocks, [
    { kind: "paragraph", runs: [{ text: "bold", bold: true }, { text: "plain" }] },
  ]);
  assert.equal(rtfToText(rtf("\\pard \\b on\\b0  off\\par")).text, "**on** off");
});

test("a picture is announced and its hex never reaches the text", () => {
  const text = rtfToText(
    rtf("\\pard{\\*\\shppict{\\pict\\pngblip ffffffffffffffff}}{\\nonshppict{\\pict\\wmetafile8 aaaaaaaaaaaaaaaa}}body\\par"),
  ).text;
  assert.match(text, /!\[image\]\(\)/);
  // Exactly one: the `nonshppict` beside it is the same picture again.
  assert.equal(text.match(/!\[image\]/g)?.length, 1);
  assert.doesNotMatch(text, /[0-9a-f]{16}/);
});

test("a row of cells is a table, not a line of pipes", () => {
  const text = rtfToText(
    rtf("\\trowd\\intbl name\\cell value\\cell\\row\\trowd\\intbl a\\cell 1\\cell\\row\\pard after\\par"),
  ).text;
  assert.equal(text, "| name | value |\n| --- | --- |\n| a | 1 |\n\nafter");
});

test("a destination's contents still never appear", () => {
  // The pin that must not move: `\*` skips whatever follows it.
  assert.equal(rtfToText(rtf("\\pard{\\*\\generator Riched20 10.0}body\\par")).text, "body");
});
