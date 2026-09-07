/**
 * The walk over `Contents/sectionN.xml`, and the order those sections are read
 * in — which is numeric, because a lexical sort puts `section10` between
 * `section1` and `section2` and silently reorders any document long enough to
 * have ten of them.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { sectionsOf, sectionXmlToBlocks, sectionXmlToText } from "@/infrastructure/documents/engine/read/hwpx";

const paragraph = (...runs: string[]) =>
  `<hp:p>${runs.map((run) => `<hp:run><hp:t>${run}</hp:t></hp:run>`).join("")}</hp:p>`;

test("each paragraph is a line", () => {
  assert.equal(sectionXmlToText(paragraph("첫째") + paragraph("둘째")), "첫째\n\n둘째");
});

test("runs inside one paragraph join without a gap", () => {
  assert.equal(sectionXmlToText(paragraph("한", "글", " 문서")), "한글 문서");
});

test("tabs and line breaks survive", () => {
  const xml = "<hp:p><hp:run><hp:t>a</hp:t><hp:tab/><hp:t>b</hp:t><hp:lineBreak/><hp:t>c</hp:t></hp:run></hp:p>";
  // A break ends the block: two lines with none between them are one
  // paragraph when the Markdown is read back.
  assert.equal(sectionXmlToText(xml), "a\tb\n\nc");
});

test("a table row is one line with its cells separated", () => {
  const xml =
    `<hp:tbl><hp:tr><hp:tc><hp:subList>${paragraph("가")}</hp:subList></hp:tc>` +
    `<hp:tc><hp:subList>${paragraph("나")}</hp:subList></hp:tc></hp:tr></hp:tbl>`;
  assert.equal(sectionXmlToText(xml), "| 가 | 나 |\n| --- | --- |");
});

test("elements are matched on their local name, not on the `hp:` prefix", () => {
  // The prefix is conventional, not required. Keying on it would return "no
  // text" for a valid document rather than an error anybody could act on.
  assert.equal(sectionXmlToText("<p><run><t>bound elsewhere</t></run></p>"), "bound elsewhere");
  assert.equal(sectionXmlToText("<x:p><x:run><x:t>또는 이렇게</x:t></x:run></x:p>"), "또는 이렇게");
});

test("everything outside a text element is dropped", () => {
  const xml =
    `<hp:sec><hp:secPr><hp:pagePr width="59528"/></hp:secPr>${paragraph("본문")}</hp:sec>`;
  assert.equal(sectionXmlToText(xml), "본문");
});

test("sections are ordered by their number, not by their name", () => {
  const entries = [
    "Contents/section10.xml",
    "Contents/section2.xml",
    "Contents/section0.xml",
    "Contents/header.xml",
    "mimetype",
  ].map((name) => ({ name, compressedSize: 1, originalSize: 1 }));
  assert.deepEqual(sectionsOf(entries), [
    "Contents/section0.xml",
    "Contents/section2.xml",
    "Contents/section10.xml",
  ]);
});

/**
 * What `Contents/header.xml` buys.
 *
 * This reader had no heading, no list and no emphasis at all: every `hp:p`
 * carries `@paraPrIDRef` and it was thrown away. Each case is run with the
 * header and without it — a missing header leaves flat paragraphs, never a
 * guessed level.
 */

const header = (paraPrs: string, extra = "") =>
  `<hh:head><hh:paraProperties>${paraPrs}</hh:paraProperties>${extra}</hh:head>`;

const paraPr = (id: string, heading: string) =>
  `<hh:paraPr id="${id}">${heading}</hh:paraPr>`;

const body = (id: string, text: string) =>
  `<hs:sec><hp:p paraPrIDRef="${id}"><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`;

test("an 개요 paragraph is a heading at its level", () => {
  // 한글 has one mechanism for a document heading and for a numbered outline,
  // and `OUTLINE` is it. Reading it is what takes this format from no
  // structure at all to a document a model can navigate.
  const head = header(paraPr("7", '<hh:heading type="OUTLINE" level="1"/>'));
  assert.deepEqual(sectionXmlToBlocks(body("7", "배경"), head), [
    { kind: "heading", level: 2, runs: [{ text: "배경" }] },
  ]);
  // Without the header it is a paragraph, not a guess.
  assert.deepEqual(sectionXmlToBlocks(body("7", "배경")), [
    { kind: "paragraph", runs: [{ text: "배경" }] },
  ]);
});

test("NUMBER counts and BULLET does not", () => {
  const numbered = header(paraPr("1", '<hh:heading type="NUMBER" level="0"/>'));
  const bulleted = header(paraPr("1", '<hh:heading type="BULLET" level="0"/>'));
  const two = body("1", "하나").replace("</hs:sec>", "") + '<hp:p paraPrIDRef="1"><hp:run><hp:t>둘</hp:t></hp:run></hp:p></hs:sec>';
  assert.equal(sectionXmlToText(two, numbered), "1. 하나\n2. 둘");
  assert.equal(sectionXmlToText(two, bulleted), "- 하나\n- 둘");
});

test("a paraPr the header does not define leaves a flat paragraph", () => {
  const head = header(paraPr("2", '<hh:heading type="OUTLINE" level="0"/>'));
  assert.deepEqual(sectionXmlToBlocks(body("99", "x"), head), [
    { kind: "paragraph", runs: [{ text: "x" }] },
  ]);
});

test("a run wearing a bold character property is bold", () => {
  const head = header("", "<hh:charProperties><hh:charPr id=\"3\"><hh:bold/></hh:charPr></hh:charProperties>");
  const xml = '<hs:sec><hp:p><hp:run charPrIDRef="3"><hp:t>강조</hp:t></hp:run></hp:p></hs:sec>';
  assert.deepEqual(sectionXmlToBlocks(xml, head), [
    { kind: "paragraph", runs: [{ text: "강조", bold: true }] },
  ]);
});

test("a cell says how far it spans, which is what makes the grid exact", () => {
  const cell = (span: string, text: string) =>
    `<hp:tc><hp:cellSpan ${span}/><hp:subList><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList></hp:tc>`;
  const xml =
    `<hp:tbl><hp:tr>${cell('colSpan="2" rowSpan="1"', "2026년")}${cell('colSpan="1" rowSpan="1"', "비고")}</hp:tr>` +
    `<hp:tr>${cell('colSpan="1" rowSpan="1"', "a")}${cell('colSpan="1" rowSpan="1"', "b")}` +
    `${cell('colSpan="1" rowSpan="1"', "c")}</hp:tr></hp:tbl>`;
  const table = sectionXmlToBlocks(xml).find((block) => block.kind === "table");
  if (table?.kind === "table") {
    assert.equal(table.columns, 3);
    assert.equal(table.rows[0]?.cells[0]?.colspan, 2);
    assert.equal(table.merged, true);
  }
});

test("a picture leaves a mark saying it was there", () => {
  const xml = '<hs:sec><hp:p><hp:run><hp:pic><hp:img binaryItemIDRef="image1.png"/></hp:pic></hp:run></hp:p></hs:sec>';
  assert.deepEqual(sectionXmlToBlocks(xml), [
    { kind: "image", alt: "image", target: "BinData/image1.png" },
  ]);
});

test("a list drawn with literal markers under a hanging indent is a list", () => {
  // This renderer writes the marker as characters and hangs it outside the
  // text, exactly as the DOCX one does. The hang is the gate.
  const head = header('<hh:paraPr id="4"><hh:margin><hc:intent value="-360"/></hh:margin></hh:paraPr>');
  const xml =
    '<hs:sec><hp:p paraPrIDRef="4"><hp:run><hp:t>- 하나</hp:t></hp:run></hp:p>' +
    '<hp:p paraPrIDRef="4"><hp:run><hp:t>- 둘</hp:t></hp:run></hp:p></hs:sec>';
  assert.equal(sectionXmlToText(xml, head), "- 하나\n- 둘");
  // No hang: the dash is a dash, escaped so it reads back as one.
  assert.equal(sectionXmlToText(xml), "\\- 하나\n\n\\- 둘");
});
