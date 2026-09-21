/**
 * The walk over `word/document.xml`, which decides what a DOCX says.
 *
 * Tested on the XML rather than on a file: the zip layer has its own tests, and
 * every decision worth making here is about which element means a line, a cell
 * or nothing at all.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { documentXmlToBlocks, documentXmlToText, partOfTarget } from "@/infrastructure/documents/engine/read/docx";

const paragraph = (...runs: string[]) =>
  `<w:p>${runs.map((run) => `<w:r><w:t>${run}</w:t></w:r>`).join("")}</w:p>`;

test("package targets resolve relative segments against the declaring directory", () => {
  assert.equal(partOfTarget("ppt/slides", "../media/image.png"), "ppt/media/image.png");
  assert.equal(partOfTarget("word", "./media/../media/image.png"), "word/media/image.png");
  assert.equal(partOfTarget("word", "/shared/image.png"), "shared/image.png");
});

test("each paragraph is a line", () => {
  const { text, paragraphs } = documentXmlToText(
    `<w:document><w:body>${paragraph("first")}${paragraph("second")}</w:body></w:document>`,
  );
  // A blank line between blocks, because two lines with none between them
  // are one paragraph when the Markdown is read back.
  assert.equal(text, "first\n\nsecond");
  assert.equal(paragraphs, 2);
});

test("runs inside one paragraph join without a gap", () => {
  // Word splits a sentence across runs at every formatting change, so a space
  // between them would appear in the middle of words a user typed together.
  assert.equal(documentXmlToText(paragraph("한", "글", " 문서")).text, "한글 문서");
});

test("tabs and breaks survive as themselves", () => {
  const xml = "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>";
  // A `w:br` ends the block: a second line inside one paragraph is a line the
  // parser folds straight back in.
  assert.equal(documentXmlToText(xml).text, "a\tb\n\nc");
});

test("a heading style becomes its Markdown prefix", () => {
  const xml =
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Background</w:t></w:r></w:p>';
  assert.equal(documentXmlToText(xml).text, "## Background");
});

test("a list paragraph is marked, whatever its numbering says", () => {
  const xml =
    "<w:p><w:pPr><w:numPr><w:ilvl w:val=\"0\"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>";
  assert.equal(documentXmlToText(xml).text, "- item");
});

test("a table row is one line with its cells separated", () => {
  const xml =
    `<w:tbl><w:tr><w:tc>${paragraph("a")}</w:tc><w:tc>${paragraph("b")}</w:tc></w:tr>` +
    `<w:tr><w:tc>${paragraph("c")}</w:tc><w:tc>${paragraph("d")}</w:tc></w:tr></w:tbl>`;
  assert.equal(documentXmlToText(xml).text, "| a | b |\n| --- | --- |\n| c | d |");
});

test("a cell holding two paragraphs stays one cell", () => {
  // The regression a naive `</w:p>` → newline produces: a multi-paragraph cell
  // breaks its own row in half, and every column after it shifts.
  const xml = `<w:tbl><w:tr><w:tc>${paragraph("one")}${paragraph("two")}</w:tc><w:tc>${paragraph("x")}</w:tc></w:tr></w:tbl>`;
  assert.equal(documentXmlToText(xml).text, "| one two | x |\n| --- | --- |");
});

test("field codes and deleted text are not the document's text", () => {
  const xml =
    "<w:p><w:r><w:instrText> HYPERLINK \\l bookmark </w:instrText></w:r>" +
    "<w:del><w:r><w:delText>removed</w:delText></w:r></w:del>" +
    "<w:r><w:t>kept</w:t></w:r></w:p>";
  assert.equal(documentXmlToText(xml).text, "kept");
});

test("runs of blank paragraphs collapse, and the ends are trimmed", () => {
  const xml = `${paragraph("")}${paragraph("")}${paragraph("a")}${paragraph("")}${paragraph("")}${paragraph("b")}${paragraph("")}`;
  assert.equal(documentXmlToText(xml).text, "a\n\nb");
});

test("a document with no text comes back empty rather than with markup in it", () => {
  const { text } = documentXmlToText(
    '<w:document><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:body></w:document>',
  );
  assert.equal(text, "");
});

test("`xml:space` and escaped characters are handled", () => {
  const xml = '<w:p><w:r><w:t xml:space="preserve">a &amp; b </w:t><w:t>c</w:t></w:r></w:p>';
  assert.equal(documentXmlToText(xml).text, "a & b c");
});

test("a numbered heading is still a heading", () => {
  // `w:pStyle` comes before `w:numPr` inside `w:pPr`, so a prefix assigned as
  // the walk passes each element let the list marker erase the heading. Korean
  // and legal templates number their headings as a matter of course.
  const xml =
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/>' +
    '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>' +
    "<w:r><w:t>Background</w:t></w:r></w:p>";
  assert.equal(documentXmlToText(xml).text, "## Background");
});

test("numbering removed is not a list", () => {
  // `w:numId="0"` is how Word says this paragraph's numbering was taken away.
  const xml =
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>' +
    "<w:r><w:t>plain</w:t></w:r></w:p>";
  assert.equal(documentXmlToText(xml).text, "plain");
});

/**
 * What the three parts beside the body buy.
 *
 * Each case is run twice in spirit: with the part, and without it. A missing,
 * malformed or self-contradicting part must leave the reader where it was —
 * `undefined` means "a flat paragraph", never "level 1".
 */

const para = (style: string, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("a Korean heading style is a heading, which the style id alone never said", () => {
  // `제목1` misses `/^Heading[1-6]$/`, and so does every house style based on a
  // heading. `w:outlineLvl` in styles.xml is what actually says the level.
  const styles =
    '<w:styles><w:style w:type="paragraph" w:styleId="제목1">' +
    '<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>';
  assert.equal(documentXmlToText(para("제목1", "배경"), { styles }).text, "# 배경");
  // Without the part it is a paragraph, not a guess.
  assert.equal(documentXmlToText(para("제목1", "배경")).text, "배경");
});

test("a style based on a heading inherits its level", () => {
  const styles =
    '<w:styles><w:style w:type="paragraph" w:styleId="Base">' +
    '<w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Mine"><w:basedOn w:val="Base"/></w:style></w:styles>';
  assert.equal(documentXmlToText(para("Mine", "x"), { styles }).text, "## x");
});

test("a basedOn cycle stops instead of hanging", () => {
  const styles =
    '<w:styles><w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style></w:styles>';
  assert.equal(documentXmlToText(para("A", "x"), { styles }).text, "x");
});

test("direct outline formatting beats the style, because it is what was said last", () => {
  const xml =
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="2"/></w:pPr>' +
    "<w:r><w:t>x</w:t></w:r></w:p>";
  assert.equal(documentXmlToText(xml).text, "### x");
});

test("a numbered list is numbered, which without numbering.xml it never was", () => {
  const numbering =
    '<w:numbering><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0">' +
    '<w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>';
  const item = (text: string) =>
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>' +
    `<w:r><w:t>${text}</w:t></w:r></w:p>`;
  assert.equal(documentXmlToText(item("첫째") + item("둘째"), { numbering }).text, "1. 첫째\n2. 둘째");
  // A bullet format stays a bullet, and no part at all stays a bullet too.
  const bullets = numbering.replace('w:val="decimal"', 'w:val="bullet"');
  assert.equal(documentXmlToText(item("x"), { numbering: bullets }).text, "- x");
  assert.equal(documentXmlToText(item("x")).text, "- x");
});

test("a hyperlink keeps its target", () => {
  const rels =
    '<Relationships><Relationship Id="rId4" Target="https://example.com/a?b=1&amp;c=2"/></Relationships>';
  const xml =
    '<w:p><w:r><w:t>see </w:t></w:r><w:hyperlink r:id="rId4"><w:r><w:t>the spec</w:t></w:r>' +
    "</w:hyperlink></w:p>";
  assert.equal(
    documentXmlToText(xml, { rels }).text,
    "see [the spec](https://example.com/a?b=1&c=2)",
  );
  // An id with no relationship behind it leaves the words and drops nothing.
  assert.equal(documentXmlToText(xml).text, "see the spec");
});

test("a self-closing hyperlink cannot capture the following text", () => {
  const rels = '<Relationships><Relationship Id="r1" Target="https://example.com"/></Relationships>';
  const xml = '<w:p><w:hyperlink r:id="r1"/><w:r><w:t>plain</w:t></w:r></w:p>';
  assert.equal(documentXmlToText(xml, { rels }).text, "plain");
});

test("relationship XML preserves quoted delimiters and namespace prefixes", () => {
  const xml = '<w:p><w:hyperlink r:id="r1"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>';
  for (const prefix of ["", "rel:"]) {
    const rels = `<${prefix}Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<${prefix}Relationship Id="r1" Target="https://example.com/?a=>b"/>` +
      `</${prefix}Relationships>`;
    const blocks = documentXmlToBlocks(xml, { rels }).blocks;
    assert.equal(blocks[0]?.kind === "paragraph" ? blocks[0].runs[0]?.href : undefined, "https://example.com/?a=>b");
  }
});

test("bold that is turned off is not bold", () => {
  // `<w:b/>` is on and `<w:b w:val="0"/>` is off. Treating any `w:b` as bold
  // is the emphasis bug nothing reports.
  const run = (properties: string, text: string) =>
    `<w:p><w:r><w:rPr>${properties}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  assert.equal(documentXmlToText(run("<w:b/>", "on")).text, "**on**");
  assert.equal(documentXmlToText(run('<w:b w:val="0"/>', "off")).text, "off");
  assert.equal(documentXmlToText(run("<w:i/>", "it")).text, "*it*");
});

test("a heading style's own boldness does not wrap every heading in asterisks", () => {
  // Style-derived emphasis is deliberately not resolved: heading styles are
  // bold, and inheriting that would put `**` around every heading in the file.
  const styles =
    '<w:styles><w:style w:type="paragraph" w:styleId="Heading1">' +
    "<w:rPr><w:b/></w:rPr></w:style></w:styles>";
  assert.equal(documentXmlToText(para("Heading1", "제목"), { styles }).text, "# 제목");
});

test("a cell that spans columns says so, and one that continues a merge adds none", () => {
  const cell = (properties: string, text: string) =>
    `<w:tc><w:tcPr>${properties}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const xml =
    "<w:tbl>" +
    `<w:tr>${cell('<w:gridSpan w:val="2"/>', "2026년")}${cell("", "비고")}</w:tr>` +
    `<w:tr>${cell("", "a")}${cell("", "b")}${cell("", "c")}</w:tr>` +
    "</w:tbl>";
  const { blocks, observed } = documentXmlToBlocks(xml);
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table");
  if (table?.kind === "table") {
    assert.equal(table.columns, 3);
    assert.equal(table.rows[0]?.cells[0]?.colspan, 2);
  }
  assert.ok(observed.includes("merged table cells"));
});

test("a vertical merge's continuation row does not add a cell of its own", () => {
  // `w:vMerge` with no `w:val` means *continue*. Reading the absent attribute
  // as "not merged" inverts it and shifts every column after it.
  const xml =
    "<w:tbl>" +
    '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>묶음</w:t></w:r></w:p></w:tc>' +
    "<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc></w:tr>" +
    "<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>" +
    "<w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
  const table = documentXmlToBlocks(xml).blocks.find((block) => block.kind === "table");
  if (table?.kind === "table") {
    assert.equal(table.columns, 2);
    assert.equal(table.rows[1]?.cells.length, 1);
  }
});

test("a header row the document marked is the table's header", () => {
  const xml =
    "<w:tbl>" +
    "<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>항목</w:t></w:r></w:p></w:tc>" +
    "<w:tc><w:p><w:r><w:t>값</w:t></w:r></w:p></w:tc></w:tr>" +
    "<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>" +
    "<w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
  const table = documentXmlToBlocks(xml).blocks.find((block) => block.kind === "table");
  if (table?.kind === "table") {
    assert.deepEqual(table.rows.map((row) => row.header === true), [true, false]);
  }
});

test("a picture leaves a mark saying it was there, and what it was called", () => {
  const rels = '<Relationships><Relationship Id="rId9" Target="media/image1.png"/></Relationships>';
  const xml =
    '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="조직도"/>' +
    '<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId9"/>' +
    "</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";
  assert.equal(documentXmlToText(xml, { rels }).text, "![조직도](word/media/image1.png)");
});

test("a fallback copy of the same picture is one picture", () => {
  // Choice and Fallback are siblings, not drawings nested inside one another.
  const xml =
    '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="a">' +
    '<w:drawing><wp:inline><wp:docPr descr="그림"/></wp:inline></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict><v:shape><v:imagedata r:id="rId1"/></v:shape></w:pict></mc:Fallback>' +
    '</mc:AlternateContent></w:r></w:p>';
  const images = documentXmlToBlocks(xml).blocks.filter((block) => block.kind === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.alt, "그림");
});

test("alternate content selects the first supported choice and otherwise its fallback", () => {
  const drawing = (alt: string) => `<w:drawing><wp:docPr descr="${alt}"/></w:drawing>`;
  const xml = '<w:p><w:r><mc:AlternateContent>' +
    `<mc:Choice Requires="future">${drawing("unsupported")}</mc:Choice>` +
    `<mc:Choice Requires="a">${drawing("first")}</mc:Choice>` +
    `<mc:Choice Requires="a">${drawing("second")}</mc:Choice>` +
    `<mc:Fallback>${drawing("fallback")}</mc:Fallback></mc:AlternateContent>` +
    '<mc:AlternateContent><mc:Choice Requires="future">' + drawing("unsupported") +
    `</mc:Choice><mc:Fallback>${drawing("fallback")}</mc:Fallback></mc:AlternateContent>` +
    '</w:r></w:p>' + paragraph("after");
  const blocks = documentXmlToBlocks(xml).blocks;
  assert.deepEqual(blocks.filter(block => block.kind === "image").map(block => block.alt), ["first", "fallback"]);
  assert.equal(blocks.at(-1)?.kind, "paragraph");
  assert.match(documentXmlToText(xml).text, /after$/);
});

test("choice requirements resolve in their namespace scope and skipped branches cannot change state", () => {
  const drawing = (alt: string) => `<w:drawing><wp:docPr descr="${alt}"/></w:drawing>`;
  const xml = '<w:document xmlns:draw="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>' +
    '<mc:AlternateContent><mc:Choice Requires="draw"><w:p><w:r>' + drawing("selected") +
    '</w:r></w:p></mc:Choice><mc:Fallback><w:tbl><w:tr><w:tc><w:p><w:r><w:b/>' +
    '<w:t>ignored</w:t></w:r></w:p></w:tc></w:tr></w:tbl></mc:Fallback></mc:AlternateContent>' +
    '<mc:AlternateContent xmlns:draw="urn:unsupported"><mc:Choice Requires="draw"><w:p/>' +
    '</mc:Choice><mc:Fallback>' + paragraph("fallback text") + '</mc:Fallback></mc:AlternateContent>' +
    paragraph("plain") + '</w:body></w:document>';
  const result = documentXmlToBlocks(xml);
  assert.deepEqual(result.blocks, [
    { kind: "image", alt: "selected" },
    { kind: "paragraph", runs: [{ text: "fallback text" }] },
    { kind: "paragraph", runs: [{ text: "plain" }] },
  ]);
  assert.deepEqual(result.observed, []);
});

test("nested alternates and self-closing branches leave later content readable", () => {
  const xml = '<mc:AlternateContent><mc:Choice Requires="future"/>' +
    '<mc:Fallback><mc:AlternateContent><mc:Choice Requires="w">' + paragraph("nested") +
    '</mc:Choice><mc:Fallback>' + paragraph("duplicate") + '</mc:Fallback></mc:AlternateContent>' +
    '</mc:Fallback></mc:AlternateContent><mc:AlternateContent/>' + paragraph("after") +
    '<mc:AlternateContent><mc:Choice Requires="future">' + paragraph("unsupported") + '</mc:Choice></mc:AlternateContent>';
  const result = documentXmlToBlocks(xml);
  assert.equal(documentXmlToText(xml).text, "nested\n\nafter");
  assert.deepEqual(result.observed, ["unsupported alternate content"]);
});

test("a list written as literal markers with a hanging indent is still a list", () => {
  // This repository's own writer produces exactly that, and Word leaves a
  // hand-typed list the same way. The hanging indent is the signal — a
  // paragraph that merely opens with a dash is a paragraph.
  const item = (left: number, text: string) =>
    `<w:p><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>` +
    `<w:r><w:t>${text}</w:t></w:r></w:p>`;
  // The step is the document's own `w:hanging`, so `left` twice over is one
  // level in: a template that indents by something other than a quarter inch
  // still nests correctly.
  assert.equal(documentXmlToText(item(360, "- one") + item(720, "1. deep")).text, "- one\n\n  1. deep");
  // No hanging indent: the dash is a dash, and it is escaped so it reads back
  // as one rather than as a list nobody wrote.
  assert.equal(documentXmlToText("<w:p><w:r><w:t>- not a list</w:t></w:r></w:p>").text, "\\- not a list");
});
