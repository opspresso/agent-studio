import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildZip, stored } from "@/infrastructure/documents/engine/zip";
import { contentXmlToBlocks, odfKindOf, odfToText, OdfError } from "@/infrastructure/documents/engine/read/odf";

const utf8 = (value: string) => new TextEncoder().encode(value);

const MIME = {
  text: "application/vnd.oasis.opendocument.text",
  spreadsheet: "application/vnd.oasis.opendocument.spreadsheet",
  presentation: "application/vnd.oasis.opendocument.presentation",
};

function odf(mimetype: string, body: string): Uint8Array {
  return buildZip({
    // First and stored, as the packaging rule requires.
    mimetype: stored(utf8(mimetype)),
    "content.xml": utf8(
      `<?xml version="1.0"?><office:document-content><office:body>${body}</office:body></office:document-content>`,
    ),
  });
}

test("the package says which kind it is", () => {
  assert.equal(odfKindOf(MIME.text), "text");
  assert.equal(odfKindOf(MIME.spreadsheet), "spreadsheet");
  assert.equal(odfKindOf(MIME.presentation), "presentation");
  assert.equal(odfKindOf("application/zip"), undefined);
});

test("a text document comes back as paragraphs", () => {
  const bytes = odf(MIME.text, `<text:h>보고서</text:h><text:p>본문입니다.</text:p>`);
  const { text, kind } = odfToText(bytes);
  assert.equal(kind, "text");
  // `text:h` is a heading now: the level was on the element being opened and
  // the reader threw it away.
  assert.equal(text, "# 보고서\n\n본문입니다.");
});

test("a spreadsheet names each sheet and separates cells", () => {
  const row = `<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>`;
  const bytes = odf(MIME.spreadsheet, `<table:table table:name="Data">${row}</table:table>`);
  const { text, kind, parts } = odfToText(bytes);
  assert.equal(kind, "spreadsheet");
  assert.equal(parts, 1);
  assert.equal(text, "## Data\n\n| A | B |\n| --- | --- |");
});

test("a presentation numbers its slides", () => {
  const bytes = odf(
    MIME.presentation,
    `<draw:page><text:p>first</text:p></draw:page><draw:page><text:p>second</text:p></draw:page>`,
  );
  const { text, parts } = odfToText(bytes);
  assert.equal(parts, 2);
  // A blank line between slides: the heading flushes the previous one, which is
  // what keeps two decks' worth of text from reading as one continuous page.
  assert.equal(text, "## Slide 1\n\nfirst\n\n## Slide 2\n\nsecond");
});

test("an encoded run of spaces survives, since XML would have collapsed it", () => {
  const bytes = odf(MIME.text, `<text:p>a<text:s text:c="3"/>b</text:p>`);
  // Normalised to one space on the way out, but not lost entirely.
  assert.equal(odfToText(bytes).text, "a b");
});

test("a tab is kept as a tab, because it is how columns are laid out", () => {
  const bytes = odf(MIME.text, `<text:p>name<text:tab/>value</text:p>`);
  assert.equal(odfToText(bytes).text, "name\tvalue");
});

test("a package that does not say what it is, is refused", () => {
  const bytes = buildZip({ mimetype: stored(utf8("application/zip")), "content.xml": utf8("<x/>") });
  assert.throws(() => odfToText(bytes), OdfError);
});

test("an empty document is refused rather than returned empty", () => {
  assert.throws(() => odfToText(odf(MIME.text, "")), OdfError);
});

test("a run of repeated cells occupies its columns, so the values after it do not shift", () => {
  // LibreOffice stores a run of identical or empty cells once, with a count.
  // Emitting one separator for the element puts every later value in a column
  // it does not belong to — a table that still looks like a table and says
  // something else.
  const row =
    `<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>` +
    `<table:table-cell table:number-columns-repeated="3"/>` +
    `<table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>`;
  const bytes = odf(MIME.spreadsheet, `<table:table table:name="Data">${row}</table:table>`);
  // Five columns: B is the fifth, not the second.
  assert.equal(odfToText(bytes).text, "## Data\n\n| A |  |  |  | B |\n| --- | --- | --- | --- | --- |");
});

test("the repeat that pads a row to the sheet's width costs nothing", () => {
  // Every ODS row ends with one of these. Expanding it eagerly would draw
  // sixteen thousand empty columns for a row holding one value.
  const row =
    `<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>` +
    `<table:table-cell table:number-columns-repeated="16384"/></table:table-row>`;
  const bytes = odf(MIME.spreadsheet, `<table:table table:name="Data">${row}</table:table>`);
  assert.equal(odfToText(bytes).text, "## Data\n\n| A |\n| --- |");
});

test("a cell covered by a merge still holds its column", () => {
  const row =
    `<table:table-row>` +
    `<table:table-cell table:number-columns-spanned="2"><text:p>A</text:p></table:table-cell>` +
    `<table:covered-table-cell/>` +
    `<table:table-cell><text:p>B</text:p></table:table-cell></table:table-row>`;
  const bytes = odf(MIME.spreadsheet, `<table:table table:name="Data">${row}</table:table>`);
  // Three columns: the covered cell is the position the span already claimed.
  assert.equal(odfToText(bytes).text, "## Data\n\n| A |  | B |\n| --- | --- | --- |");
});

test("text a change tracker deleted is not the document's text", () => {
  // `text:tracked-changes` sits at the top of the body and holds whole deleted
  // paragraphs. Returning them puts text the author removed at the top of the
  // document, as if it were current.
  const bytes = odf(
    MIME.text,
    `<office:text><text:tracked-changes><text:changed-region><text:deletion>` +
      `<office:change-info><dc:creator>김철수</dc:creator><dc:date>2026-01-02</dc:date></office:change-info>` +
      `<text:p>removed</text:p></text:deletion></text:changed-region></text:tracked-changes>` +
      `<text:p>kept</text:p></office:text>`,
  );
  assert.equal(odfToText(bytes).text, "kept");
});

test("a comment is not the paragraph it is anchored in", () => {
  const bytes = odf(
    MIME.text,
    `<office:text><text:p>본문<office:annotation><dc:creator>김철수</dc:creator>` +
      `<text:p>확인 필요</text:p></office:annotation>입니다.</text:p></office:text>`,
  );
  assert.equal(odfToText(bytes).text, "본문입니다.");
});

test("skipped annotation markup cannot change an enclosing link", () => {
  const blocks = contentXmlToBlocks(
    '<office:body><text:p><text:a xlink:href="https://outer.example">before' +
      '<office:annotation><text:p><text:a xlink:href="https://inner.example">skip</text:a>' +
      '</text:p></office:annotation>after</text:a></text:p></office:body>',
    "text",
  ).blocks;
  assert.deepEqual(blocks, [{
    kind: "paragraph",
    runs: [{ text: "beforeafter", href: "https://outer.example" }],
  }]);
});

test("a footnote does not split the paragraph it hangs from", () => {
  // The footnote's own `</text:p>` used to flush, cutting the host paragraph in
  // half with the note's text between the pieces.
  const bytes = odf(
    MIME.text,
    `<office:text><text:p>앞<text:note text:note-class="footnote">` +
      `<text:note-citation>1</text:note-citation>` +
      `<text:note-body><text:p>각주 본문</text:p></text:note-body>` +
      `</text:note>뒤</text:p></office:text>`,
  );
  assert.equal(odfToText(bytes).text, "앞뒤");
});

test("speaker notes are not slide content", () => {
  // `document.ts` promises a deck comes back without speaker notes. The ODP
  // path said so and did the opposite.
  const bytes = odf(
    MIME.presentation,
    `<draw:page><text:p>slide</text:p>` +
      `<presentation:notes><draw:frame><draw:text-box><text:p>말할 것</text:p></draw:text-box></draw:frame></presentation:notes>` +
      `</draw:page>`,
  );
  assert.equal(odfToText(bytes).text, "## Slide 1\n\nslide");
});

/** The body only, so a case is a string rather than an archive. */
const body = (xml: string, kind: "text" | "spreadsheet" | "presentation" = "text") =>
  contentXmlToBlocks(`<office:document-content><office:body>${xml}</office:body></office:document-content>`, kind)
    .blocks;

test("a heading states its own level, which was being thrown away", () => {
  const blocks = body(`<text:h text:outline-level="3">배경</text:h>`);
  assert.deepEqual(blocks, [{ kind: "heading", level: 3, runs: [{ text: "배경" }] }]);
  // Old writers say `text:level`, and a heading with neither is level 1.
  assert.equal(body(`<text:h text:level="2">x</text:h>`)[0]?.kind, "heading");
  assert.deepEqual(body(`<text:h>x</text:h>`), [
    { kind: "heading", level: 1, runs: [{ text: "x" }] },
  ]);
});

test("a level past six is clamped rather than dropped", () => {
  assert.deepEqual(body(`<text:h text:outline-level="9">깊은 제목</text:h>`), [
    { kind: "heading", level: 6, runs: [{ text: "깊은 제목" }] },
  ]);
});

test("a list is a list, and its depth is how many lists it sits inside", () => {
  const blocks = body(
    `<text:list><text:list-item><text:p>하나</text:p></text:list-item>` +
      `<text:list-item><text:list><text:list-item><text:p>안쪽</text:p></text:list-item></text:list></text:list-item>` +
      `</text:list>`,
  );
  assert.deepEqual(blocks, [
    {
      kind: "list",
      ordered: false,
      items: [
        { runs: [{ text: "하나" }], depth: 0 },
        { runs: [{ text: "안쪽" }], depth: 1 },
      ],
    },
  ]);
});

test("a numbered list style makes a numbered list", () => {
  const xml =
    `<office:automatic-styles>` +
    `<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>` +
    `</office:automatic-styles>` +
    `<office:body><text:list text:style-name="L1"><text:list-item><text:p>첫째</text:p></text:list-item></text:list></office:body>`;
  const { blocks } = contentXmlToBlocks(`<office:document-content>${xml}</office:document-content>`, "text");
  assert.equal(blocks[0]?.kind, "list");
  if (blocks[0]?.kind === "list") {
    assert.equal(blocks[0].ordered, true);
  }
});

test("a nested list with no style of its own inherits the one outside it", () => {
  // "No style named" is not "a bullet" — a nested `text:list` omits the name
  // and inherits, so reading the absence as a default renumbers half a list.
  const xml =
    `<office:automatic-styles>` +
    `<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/>` +
    `<text:list-level-style-number text:level="2"/></text:list-style>` +
    `</office:automatic-styles><office:body>` +
    `<text:list text:style-name="L1"><text:list-item><text:list><text:list-item>` +
    `<text:p>안쪽</text:p></text:list-item></text:list></text:list-item></text:list></office:body>`;
  const { blocks } = contentXmlToBlocks(`<office:document-content>${xml}</office:document-content>`, "text");
  assert.equal(blocks[0]?.kind === "list" && blocks[0].ordered, true);
});

test("a link keeps the address, not only the words that pointed at it", () => {
  const blocks = body(`<text:p>see <text:a xlink:href="https://x/a?b=1&amp;c=2">here</text:a></text:p>`);
  assert.deepEqual(blocks, [
    {
      kind: "paragraph",
      runs: [{ text: "see " }, { text: "here", href: "https://x/a?b=1&c=2" }],
    },
  ]);
});

test("a span wearing a bold style is bold", () => {
  const xml =
    `<office:automatic-styles>` +
    `<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>` +
    `<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>` +
    `</office:automatic-styles><office:body>` +
    `<text:p>a<text:span text:style-name="T1">b</text:span><text:span text:style-name="T2">c</text:span></text:p>` +
    `</office:body>`;
  const { blocks } = contentXmlToBlocks(`<office:document-content>${xml}</office:document-content>`, "text");
  assert.deepEqual(blocks, [
    {
      kind: "paragraph",
      runs: [{ text: "a" }, { text: "b", bold: true }, { text: "c", italic: true }],
    },
  ]);
});

test("a picture leaves a mark saying it was there", () => {
  const blocks = body(
    `<text:p><draw:frame draw:name="조직도"><draw:image xlink:href="Pictures/1.png"/></draw:frame></text:p>`,
  );
  assert.deepEqual(blocks, [{ kind: "image", alt: "조직도", target: "Pictures/1.png" }]);
});

test("a slide keeps the name the deck gave it", () => {
  const blocks = body(`<draw:page draw:name="개요"><text:p>x</text:p></draw:page>`, "presentation");
  assert.deepEqual(blocks[0], { kind: "break", unit: "slide", index: 1, name: "개요" });
});

test("a header row the document marked is the table's header", () => {
  const xml =
    `<table:table table:name="T">` +
    `<table:table-header-rows><table:table-row>` +
    `<table:table-cell><text:p>항목</text:p></table:table-cell>` +
    `<table:table-cell><text:p>값</text:p></table:table-cell></table:table-row></table:table-header-rows>` +
    `<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell>` +
    `<table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>`;
  const blocks = body(xml, "spreadsheet");
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table");
  if (table?.kind === "table") {
    assert.deepEqual(table.rows.map((row) => row.header === true), [true, false]);
  }
});

test("a spanning cell says how far it reaches", () => {
  const xml =
    `<table:table table:name="T"><table:table-row>` +
    `<table:table-cell table:number-columns-spanned="2"><text:p>2026년</text:p></table:table-cell>` +
    `<table:covered-table-cell/>` +
    `<table:table-cell><text:p>비고</text:p></table:table-cell></table:table-row>` +
    `<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell>` +
    `<table:table-cell><text:p>b</text:p></table:table-cell>` +
    `<table:table-cell><text:p>c</text:p></table:table-cell></table:table-row></table:table>`;
  const table = body(xml, "spreadsheet").find((block) => block.kind === "table");
  if (table?.kind === "table") {
    assert.equal(table.columns, 3);
    assert.equal(table.merged, true);
    assert.equal(table.rows[0]?.cells[0]?.colspan, 2);
  }
});

test("a self-closing frame does not lend its name to the next picture", () => {
  // `<draw:frame/>` gets no close event, so the name it declared used to stay
  // set — and the next picture was captioned with somebody else's alt text.
  const { blocks } = contentXmlToBlocks(
    '<office:body><office:text>' +
      '<draw:frame draw:name="빈 자리"/>' +
      '<text:p><draw:image xlink:href="Pictures/a.png"/></text:p>' +
      "</office:text></office:body>",
    "text",
  );

  const image = blocks.find((block) => block.kind === "image");
  assert.equal(image?.kind === "image" ? image.alt : undefined, "image");
  // A frame that does close still names the picture inside it.
  const named = contentXmlToBlocks(
    '<office:body><office:text>' +
      '<draw:frame draw:name="조직도"><draw:image xlink:href="Pictures/b.png"/></draw:frame>' +
      "</office:text></office:body>",
    "text",
  ).blocks.find((block) => block.kind === "image");
  assert.equal(named?.kind === "image" ? named.alt : undefined, "조직도");
});
