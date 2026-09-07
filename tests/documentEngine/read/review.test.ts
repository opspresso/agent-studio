/**
 * What a review found, pinned.
 *
 * Every case here returned something the document did not say, and each one is
 * written so that undoing its fix fails it. They share a shape: a counter that
 * did not come back down, a value read after it was cleared, or a delimiter the
 * parser could not tell from the text around it — the class this whole change
 * exists to remove, found once more inside it.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseInline, parseMarkdown, plainTextOf } from "@/infrastructure/documents/engine/markdown";
import { documentXmlToBlocks, documentXmlToText } from "@/infrastructure/documents/engine/read/docx";
import { contentXmlToBlocks } from "@/infrastructure/documents/engine/read/odf";
import { slideXmlToBlocks } from "@/infrastructure/documents/engine/read/pptx";
import { rtfToText } from "@/infrastructure/documents/engine/read/rtf";
import { inspectBlocks } from "@/infrastructure/documents/engine/read/inspect";
import { blocksToMarkdown } from "@/infrastructure/documents/engine/read/serialize";
import type { ReadBlock } from "@/infrastructure/documents/engine/read/blocks";

const md = (blocks: ReadBlock[], max = 9000) => blocksToMarkdown(blocks, max).text;
const shape = (body: string) => `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
const rtf = (body: string) => new TextEncoder().encode(`{\\rtf1\\ansi ${body}}`);
const cell = (text: string) => `<table:table-cell><text:p>${text}</text:p></table:table-cell>`;
const tc = (properties: string, text: string) =>
  `<w:tc><w:tcPr>${properties}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

test("a link ends with the run that declared it", () => {
  // `a:hlinkClick` is self-closing in every deck — this repository's own writer
  // emits it that way — and a self-closing tag gets no `close`, so clearing the
  // href there alone made every paragraph after a link that same link.
  const blocks = slideXmlToBlocks(
    `<p:spTree>${shape(
      `<a:p><a:r><a:rPr><a:hlinkClick r:id="rId2"/></a:rPr><a:t>link</a:t></a:r></a:p>` +
        `<a:p><a:r><a:t>not a link</a:t></a:r></a:p>`,
    )}</p:spTree>`,
    '<Relationships><Relationship Id="rId2" Target="https://x/a"/></Relationships>',
  );
  assert.equal(md(blocks), "[link](https://x/a)\n\nnot a link");
});

test("an escaped delimiter inside emphasis is not the closing one", () => {
  // `*SELECT \* FROM t*` closed on the escaped asterisk: the run came back as
  // `SELECT \` with ` FROM t*` beside it — a backslash in the prose and the
  // asterisk moved to the end of the sentence.
  for (const run of [
    { text: "SELECT * FROM t", italic: true },
    { text: "a _b", bold: true, italic: true },
    { text: "**x**", italic: true },
  ]) {
    const text = md([{ kind: "paragraph", runs: [run] }]);
    assert.deepEqual(parseInline(text), [run], text);
  }
});

test("a vertical merge takes the rows it covers with it", () => {
  // DOCX says `restart` and `continue` rather than a count, so the count has to
  // be made — without a `rowspan` the grid reserves nothing and every value in
  // the continuing row shifts one column left.
  const text = documentXmlToText(
    "<w:tbl>" +
      `<w:tr>${tc('<w:vMerge w:val="restart"/>', "A")}${tc("", "B")}${tc("", "C")}</w:tr>` +
      `<w:tr>${tc("<w:vMerge/>", "")}${tc("", "D")}${tc("", "E")}</w:tr></w:tbl>`,
  ).text;
  assert.equal(text, "| A | B | C |\n| --- | --- | --- |\n|  | D | E |");
});

test("a table inside a skipped subtree leaves the real one standing", () => {
  // `open` did not push inside an annotation and `close` popped anyway, so the
  // outer table was finished early and every cell after it had nowhere to go.
  const blocks = contentXmlToBlocks(
    `<office:body><table:table table:name="T"><table:table-row>` +
      `<table:table-cell><text:p>A<office:annotation><table:table><table:table-row>${cell("x")}` +
      `</table:table-row></table:table></office:annotation></text:p></table:table-cell>` +
      `${cell("B")}</table:table-row><table:table-row>${cell("C")}${cell("D")}</table:table-row>` +
      `</table:table></office:body>`,
    "text",
  ).blocks;
  assert.equal(md(blocks), "| A | B |\n| --- | --- |\n| C | D |");
});

test("a self-closing element does not raise a depth for the rest of the document", () => {
  // `<w:pPr/>` read as "always inside paragraph properties", so every `w:b`
  // after it was taken for a paragraph mark's own formatting and ignored.
  assert.equal(
    documentXmlToText("<w:p><w:pPr/><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>").text,
    "**bold**",
  );
  // `<w:drawing/>` read as "still inside a drawing", so every later picture was
  // taken for an `mc:AlternateContent` duplicate of it and none was reported.
  const images = documentXmlToBlocks(
    "<w:p><w:r><w:drawing/><w:t>after</w:t></w:r></w:p>" +
      '<w:p><w:r><w:drawing><wp:docPr descr="chart"/></w:drawing></w:r></w:p>',
  ).blocks.filter((block) => block.kind === "image");
  assert.equal(images.length, 1);
});

test("a paragraph break inside a cell joins rather than discards", () => {
  // The runs were cleared before the in-table check read them, so a cell's
  // first line was gone by the time anything asked what the cell said.
  assert.equal(
    rtfToText(rtf("\\trowd\\intbl first\\par second\\cell B\\cell\\row\\pard after\\par")).text,
    "| first second | B |\n| --- | --- |\n\nafter",
  );
});

test("what a cell holds stays in the cell", () => {
  // Each of these called `endParagraph` from inside a cell, which pushed the
  // cell's own words out of the table as a paragraph of their own.
  const pptx = md(
    slideXmlToBlocks(
      `<p:spTree>${shape(
        "<a:tbl><a:tr><a:tc><a:p><a:r><a:t>one</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p>" +
          "</a:tc><a:tc><a:p><a:r><a:t>B</a:t></a:r></a:p></a:tc></a:tr></a:tbl>",
      )}</p:spTree>`,
    ),
  );
  assert.equal(pptx, "| one two | B |\n| --- | --- |");

  const odf = contentXmlToBlocks(
    `<office:body><table:table table:name="T"><table:table-row>` +
      `<table:table-cell><text:p>before<draw:frame draw:name="chart">` +
      `<draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p></table:table-cell>` +
      `${cell("B")}</table:table-row></table:table></office:body>`,
    "text",
  );
  assert.equal(md(odf.blocks), "| before | B |\n| --- | --- |");
  // And the loss is reported rather than left to be noticed.
  assert.ok(odf.observed.includes("pictures inside table cells"));

  const nested = documentXmlToBlocks(
    "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>" +
      `<w:tbl><w:tr>${tc("", "in1")}${tc("", "in2")}</w:tr></w:tbl>` +
      `</w:tc>${tc("", "right")}</w:tr></w:tbl>`,
  );
  assert.equal(md(nested.blocks), "| outer in1 in2 | right |\n| --- | --- |");
  assert.ok(nested.observed.includes("a table nested inside a cell"));
});

test("a heading inside a cell does not outlive the table", () => {
  // The level is cleared by `endParagraph`, which a cell never reaches — so the
  // first body paragraph after the table wore it, inventing a heading.
  const blocks = contentXmlToBlocks(
    `<office:body><table:table table:name="T"><table:table-row>` +
      `<table:table-cell><text:h text:outline-level="2">Cell heading</text:h></table:table-cell>` +
      `${cell("plain")}</table:table-row></table:table><text:p>ordinary body</text:p></office:body>`,
    "text",
  ).blocks;
  assert.equal(blocks[blocks.length - 1]?.kind, "paragraph");
});

test("an exclamation mark beside a link stays an exclamation mark", () => {
  // A link writes a real `[`, so `주의!` against one spells `![` and the pair is
  // read back as an image — the mark eaten and the link turned into a picture.
  const text = md([
    { kind: "paragraph", runs: [{ text: "주의!" }, { text: "여기", href: "http://x/y" }] },
  ]);
  assert.deepEqual(parseInline(text), [
    { text: "주의!" },
    { text: "여기", href: "http://x/y" },
  ]);
});

test("a block bigger than one call still gets a line of its own", () => {
  // Reporting `to: from` with nothing written claimed the block was covered; a
  // caller paging by `from = to + 1` then stepped over it and never saw it.
  const rows = Array.from({ length: 4000 }, (_, index) => ({
    cells: [{ runs: [{ text: `row ${index}` }] }, { runs: [{ text: "x".repeat(60) }] }],
  }));
  const huge: ReadBlock = {
    kind: "table",
    rows,
    columns: 2,
    align: ["left", "left"],
    totalRows: rows.length,
    merged: false,
  };
  const described = inspectBlocks([huge, { kind: "paragraph", runs: [{ text: "after" }] }]);
  assert.equal(described.to, 0, "block 0 was described");
  assert.match(described.text, /^0 table rows=4000 /);
  const onlyBlock = inspectBlocks([huge]);
  assert.equal(onlyBlock.complete, false, "a table summary does not include all its rows");
});

test("a list and a code block answer to the budget", () => {
  // Writing them regardless made them all-or-nothing, and a list that wrote
  // nothing still spent the budget the blocks after it were denied.
  const list: ReadBlock = {
    kind: "list",
    ordered: false,
    items: Array.from({ length: 20 }, (_, index) => ({ runs: [{ text: `item ${index}` }], depth: 0 })),
  };
  const written = blocksToMarkdown([{ kind: "paragraph", runs: [{ text: "intro" }] }, list], 120);
  assert.equal(written.complete, false);
  assert.ok(written.text.includes("- item 0"), written.text);
});

test("a table written whole does not report rows it did not lose", () => {
  // `kept` skipped the header and `total` counted it, so a complete table said
  // "1 of 2".
  const written = blocksToMarkdown(
    [
      {
        kind: "table",
        rows: [
          { cells: [{ runs: [{ text: "a" }] }, { runs: [{ text: "b" }] }], header: true },
          { cells: [{ runs: [{ text: "c" }] }, { runs: [{ text: "d" }] }] },
        ],
        columns: 2,
        align: ["left", "left"],
        totalRows: 2,
        merged: false,
      },
    ],
    9000,
  );
  assert.equal(written.complete, true);
  assert.equal(written.rows, undefined);
});

test("a marker capture ends with its own group", () => {
  // Any `}` ended it, so a marker holding a nested group stopped being captured
  // after the inner one and the rest leaked into the prose.
  assert.equal(
    rtfToText(rtf("\\pard{\\listtext{\\*\\x}\\f3 1.\\tab}item one\\par")).text,
    "1. item one",
  );
});

test("`\\ucN` and the Windows-1252 high range are read as written", () => {
  // `\uc0` means no fallback at all, and taking one anyway ate the character
  // after every escape. latin1 turns 0x92 into an invisible control character
  // where `\ansi` means a right single quote.
  assert.equal(rtfToText(rtf("\\uc0 don\\u8217 t stop\\par")).text, "don’t stop");
  assert.equal(rtfToText(rtf("don\\'92t stop\\par")).text, "don’t stop");
});

test("a bracket run does not cost a walk per bracket", () => {
  // `MAX_MARKDOWN_CHARS` of `[` held the event loop for minutes: each one tried
  // a link pattern that backtracked across the whole remainder.
  const started = performance.now();
  parseMarkdown("[".repeat(64_000));
  assert.ok(performance.now() - started < 500, "a link needs a `](` to be worth trying");
});

test("a tracked insertion says it is one", () => {
  // Its text is `w:t` like any other, so nothing in the text says so.
  const [first, second] = documentXmlToBlocks(
    "<w:p><w:ins><w:r><w:t>proposed</w:t></w:r></w:ins></w:p>" +
      "<w:p><w:r><w:t>plain</w:t></w:r></w:p>",
  ).blocks;
  assert.equal(first?.marks?.revision, "inserted");
  assert.equal(second?.marks?.revision, undefined);
});

test("an alt text keeps a backslash that was never an escape", () => {
  const text = md([{ kind: "image", alt: "C:\\dir", target: "m.png" }]);
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind === "paragraph" ? plainTextOf(block.runs) : "", "C:\\dir");
});
