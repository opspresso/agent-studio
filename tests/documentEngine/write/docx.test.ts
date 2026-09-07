/**
 * DOCX generation, checked by reading it back.
 *
 * The round trip is the strongest end-to-end check available without opening
 * Word: it runs the real zip, the real OOXML and the real extractor, and it
 * fails if either side stops agreeing with the other. What it cannot check is
 * whether Word calls the file valid — that is a manual step, and the structural
 * assertions below stand in for the parts of it that have actually gone wrong
 * (a cell with no paragraph in it, a hyperlink with no relationship).
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { docxToText } from "@/infrastructure/documents/engine/read/docx";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { listEntries, readEntries } from "@/infrastructure/documents/engine/zip";
import { renderDocx } from "@/infrastructure/documents/engine/write/docx";
import { PALETTE } from "@/infrastructure/documents/engine/write/theme";

const CREATED = "2026-08-05T00:00:00Z";

function build(markdown: string): Uint8Array {
  return renderDocx(parseMarkdown(markdown), { title: "test", created: CREATED });
}

function roundTrip(markdown: string): string {
  return docxToText(build(markdown)).text;
}

function partOf(bytes: Uint8Array, name: string): string {
  const part = readEntries(bytes, [name]).get(name);
  assert.ok(part, `expected the archive to hold ${name}`);
  return new TextDecoder().decode(part);
}

test("a document has exactly the parts its content types declare", () => {
  const bytes = build("# Title\n\nbody");
  const names = listEntries(bytes).map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/footer1.xml",
    "word/header1.xml",
    "word/styles.xml",
  ]);
  const types = partOf(bytes, "[Content_Types].xml");
  for (const declared of [
    "/word/document.xml",
    "/word/styles.xml",
    "/word/footer1.xml",
    "/word/header1.xml",
    "/docProps/core.xml",
    "/docProps/app.xml",
  ]) {
    assert.ok(types.includes(declared), `content types should name ${declared}`);
  }
});

test("the page number is a field, and the footer it sits in is wired to the section", () => {
  const bytes = build("# Title\n\nbody");
  // A number written here would be wrong the moment the text reflowed; `PAGE`
  // is computed by Word when the document is opened.
  assert.match(partOf(bytes, "word/footer1.xml"), /<w:fldSimple w:instr=" PAGE ">/);
  const id = /<w:footerReference w:type="default" r:id="(rId\d+)"\/>/.exec(
    partOf(bytes, "word/document.xml"),
  )?.[1];
  assert.ok(id, "the section must reference the footer");
  const rels = partOf(bytes, "word/_rels/document.xml.rels");
  assert.ok(rels.includes(`Id="${id}"`) && rels.includes('Target="footer1.xml"'));
});

test("headings survive with their level, the cover set apart by its page break", () => {
  // The opening `#` is now a cover page; the blank line in the extraction is
  // the page break between the cover and the body, honestly reported.
  assert.equal(roundTrip("# 제목\n\n## 부제\n\n본문"), "# 제목\n\n## 부제\n\n본문");
  // Without a leading `#` there is no cover and nothing changes.
  assert.equal(roundTrip("## 부제\n\n본문"), "## 부제\n\n본문");
});

test("styled text keeps its characters, and the styling is in the markup", () => {
  const bytes = build("plain **bold** and *italic* and `code`");
  assert.equal(docxToText(bytes).text, "plain **bold** and *italic* and code");
  const body = partOf(bytes, "word/document.xml");
  assert.ok(body.includes("<w:b/>"), "bold should be a run property");
  assert.ok(body.includes("<w:i/>"), "italic should be a run property");
  assert.ok(body.includes('<w:rStyle w:val="CodeChar"/>'), "code should use the code character style");
});

test("a run's leading and trailing spaces are preserved", () => {
  // Without `xml:space="preserve"` Word drops them and closes the gap, so
  // `**bold** text` comes out as `boldtext`.
  assert.equal(roundTrip("**bold** text"), "**bold** text");
  assert.ok(partOf(build("a b"), "word/document.xml").includes('xml:space="preserve"'));
});

test("body, headings and cover carry deliberate leading and native tracking", () => {
  const bytes = build("# 여러 줄 표지 제목\n\n부제\n\n## 여러 줄 본문 제목\n\n본문");
  const styles = partOf(bytes, "word/styles.xml");
  const body = partOf(bytes, "word/document.xml");
  assert.ok(styles.includes('<w:spacing w:after="120" w:line="360" w:lineRule="auto"/>'));
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="Heading1">[\s\S]*?<w:spacing w:before="240" w:after="80" w:line="288" w:lineRule="auto"\/>/);
  assert.ok(styles.includes('<w:spacing w:val="0"/><w:kern w:val="24"/>'));
  assert.ok(body.includes('<w:spacing w:before="0" w:after="240" w:line="276" w:lineRule="auto"/>'));
  assert.ok(body.includes('<w:spacing w:after="0" w:line="336" w:lineRule="auto"/>'));
});

test("lists come back as the markers they were written with", () => {
  assert.equal(roundTrip("- one\n- two"), "- one\n- two");
  assert.equal(roundTrip("1. first\n2. second"), "1. first\n2. second");
});

test("a nested list numbers from one each time it is entered", () => {
  const text = roundTrip("1. a\n  1. a.1\n  2. a.2\n2. b\n  1. b.1");
  assert.equal(text, "1. a\n  1. a.1\n  2. a.2\n2. b\n  1. b.1");
});

test("a table becomes a table, and every cell has a paragraph in it", () => {
  const bytes = build("| 이름 | 값 |\n|---|---|\n| a | 1 |\n| b |  |");
  assert.equal(docxToText(bytes).text, "| **이름** | **값** |\n| --- | --- |\n| a | 1 |\n| b |  |");
  const body = partOf(bytes, "word/document.xml");
  // A `w:tc` with no `w:p` inside is what makes Word call a file corrupt.
  assert.equal(/<w:tc>(?:(?!<w:p[ />]).)*<\/w:tc>/s.test(body), false);
});

test("a technical profile uses its restrained light table header", () => {
  const bytes = renderDocx(parseMarkdown("| 이름 | 값 |\n|---|---:|\n| 처리량 | 42 |"), {
    title: "test",
    created: CREATED,
    profile: "technical",
  });
  const body = partOf(bytes, "word/document.xml");
  assert.ok(body.includes('<w:shd w:val="clear" w:color="auto" w:fill="E8F3F1"/>'));
  assert.ok(body.includes('<w:color w:val="0F4C5C"/>'));
});

test("a column asked to be set right is set right, and a plain one is untouched", () => {
  const aligned = partOf(build("| a | n |\n|---|---:|\n| x | 42 |"), "word/document.xml");
  assert.equal(aligned.match(/<w:jc w:val="right"\/>/g)?.length, 2, "header and cell both move");
  const plain = partOf(build("| a | n |\n|---|---|\n| x | 42 |"), "word/document.xml");
  assert.equal(plain.includes("<w:jc"), false, "left is Word's default and needs no element");
});

test("a link is a hyperlink with a relationship behind it", () => {
  const bytes = build("see [the spec](https://example.com/s)");
  assert.equal(docxToText(bytes).text, "see [the spec](https://example.com/s)");
  const body = partOf(bytes, "word/document.xml");
  const id = /<w:hyperlink r:id="(rId\d+)">/.exec(body)?.[1];
  assert.ok(id, "the link should be a w:hyperlink");
  const rels = partOf(bytes, "word/_rels/document.xml.rels");
  assert.ok(
    rels.includes(`Id="${id}"`) && rels.includes('Target="https://example.com/s"'),
    "the hyperlink id must resolve to an external relationship",
  );
});

test("one link across several runs is one hyperlink, not one per run", () => {
  const body = partOf(build("[**bold** and plain](https://example.com)"), "word/document.xml");
  assert.equal(body.match(/<w:hyperlink /g)?.length, 1);
});

test("the same target twice reuses its relationship", () => {
  const bytes = build("[a](https://example.com) and [b](https://example.com)");
  const rels = partOf(bytes, "word/_rels/document.xml.rels");
  assert.equal(rels.match(/Type="[^"]*\/hyperlink"/g)?.length, 1);
});

test("a code block keeps its lines", () => {
  assert.equal(roundTrip("```ts\nconst a = 1;\nconst b = 2;\n```"), "const a = 1;\n\nconst b = 2;");
});

test("XML metacharacters in the text do not become markup", () => {
  const text = roundTrip('a < b & c > d "quoted"');
  assert.equal(text, 'a < b & c > d "quoted"');
});

test("the title lands in the document properties, escaped", () => {
  const bytes = renderDocx(parseMarkdown("body"), { title: 'A & B <report>', created: CREATED });
  const core = partOf(bytes, "docProps/core.xml");
  assert.ok(core.includes("<dc:title>A &amp; B &lt;report&gt;</dc:title>"));
  assert.ok(core.includes(CREATED));
});

test("the file records what wrote it", () => {
  // Which release made a document is the first question asked about one that
  // renders oddly, and OOXML has a field for exactly that.
  assert.match(partOf(build("body"), "docProps/app.xml"), /<Application>Agent Studio \d+\.\d+\.\d+<\/Application>/);
});

test("the same input twice produces the same bytes", () => {
  // The created timestamp is passed in rather than read from the clock, so a
  // document is a function of its input — which is what makes a diff of two
  // outputs mean something.
  assert.deepEqual(build("# same\n\ntext"), build("# same\n\ntext"));
});

test("an empty document is still a document", () => {
  const bytes = renderDocx({ blocks: [] }, { title: "empty", created: CREATED });
  assert.ok(listEntries(bytes).length > 0);
  assert.ok(partOf(bytes, "word/document.xml").includes("<w:body>"));
});

test("a pptx directive renders as its contents, with no fence in the page", () => {
  // `:::cards` is a deck-planning hint; on a page the contents stand where it
  // stood, and the fences never reach the text.
  const text = roundTrip(":::cards\n### 하나\n\n설명\n:::\n\n뒤 문단");
  assert.ok(text.includes("하나"));
  assert.ok(text.includes("설명"));
  assert.ok(text.includes("뒤 문단"));
  assert.equal(text.includes(":::"), false);
});

test("the cover borrows Heading1, oversized, and the running head stays out of the text", () => {
  const bytes = build("# 분기 보고서\n\n요약 한 줄\n\n## 본론\n\n내용");
  const body = partOf(bytes, "word/document.xml");
  // The cover title is Heading1 (so it reads back as `#`) with the cover size
  // inline, and the section marks the first page as the title page.
  assert.match(body, /Heading1[^<]*"\/>[\s\S]*?<w:sz w:val="60"\/>/);
  assert.ok(body.includes("<w:titlePg/>"), "the cover carries no running head or number");
  assert.ok(body.includes('<w:br w:type="page"/>'), "the cover ends with a page break");
  // `build` renders with the title "test": the header names the document's
  // title, and the reader — which reads only the body part — never sees it.
  assert.ok(partOf(bytes, "word/header1.xml").includes(">test<"), "the header names the document");
  assert.equal(docxToText(bytes).text.includes("test"), false, "the running head stays out");
});

test("a document with no leading # gets no cover and no title page", () => {
  const body = partOf(build("본문뿐"), "word/document.xml");
  assert.equal(body.includes("<w:titlePg/>"), false);
  assert.equal(body.includes('<w:br w:type="page"/>'), false);
});

test("a mid-document # opens a numbered chapter on a fresh page", () => {
  const bytes = build("# 표지\n\n부제\n\n# 첫 장\n\n내용\n\n# 둘째 장");
  const body = partOf(bytes, "word/document.xml");
  assert.equal(body.match(/<w:pageBreakBefore\/>/g)?.length, 2, "each chapter starts a page");
  const text = docxToText(bytes).text;
  // The chapter number is set bold, and the reader recovers that now.
  assert.ok(text.includes("**01**\n\n# 첫 장"), text);
  assert.ok(text.includes("**02**\n\n# 둘째 장"), text);
});

test("a quote is a callout: the tint behind it, the bar beside it", () => {
  const styles = partOf(build("> 인용문"), "word/styles.xml");
  assert.match(
    styles,
    new RegExp(`Quote[\\s\\S]*?<w:shd w:val="clear" w:color="auto" w:fill="${PALETTE.brandTint}"/>`),
  );
});

test(":::metrics becomes a key-figure strip, and only when asked", () => {
  const asked = build(":::metrics\n- 99.99% 가용성\n- 43% 절감\n:::");
  const body = partOf(asked, "word/document.xml");
  assert.match(body, /<w:sz w:val="52"\/>/, "the figure takes the metric size");
  assert.ok(docxToText(asked).text.includes("99.99%"));
  // The same list outside a directive is a list: a page transforms nothing unasked.
  const unasked = partOf(build("## 성과\n\n- 99.99% 가용성\n- 43% 절감"), "word/document.xml");
  assert.equal(unasked.includes('<w:sz w:val="52"/>'), false);
});

test(":::comparison becomes a two-column table with the columns as its header", () => {
  const text = docxToText(
    build(":::comparison\n### IRSA\n\n- 표준 방식\n\n### Pod Identity\n\n- 신규 권장\n:::"),
  ).text;
  assert.ok(text.includes("| **IRSA** | **Pod Identity** |"), text);
  assert.ok(text.includes("| 표준 방식 | 신규 권장 |"), text);
});

test("an asset image standing alone becomes a centred figure with its caption", () => {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x00, 0x00, 0x00, 0x0d], 8);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 400);
  const bytes = renderDocx(parseMarkdown("![전체 구조](asset://d.png)\n\n다음 문단"), {
    title: "t",
    created: CREATED,
    assets: { "d.png": { mimeType: "image/png", bytes: png } },
  });
  const body = partOf(bytes, "word/document.xml");
  assert.ok(body.includes("<w:drawing>"), "the image is a native drawing");
  const embed = /<a:blip r:embed="(rId\d+)"\/>/.exec(body)?.[1];
  assert.ok(embed, "the blip names a relationship");
  const rels = partOf(bytes, "word/_rels/document.xml.rels");
  assert.ok(rels.includes(`Id="${embed}"`) && rels.includes('Target="media/image1.png"'));
  assert.ok(partOf(bytes, "[Content_Types].xml").includes('Extension="png"'));
  assert.ok(readEntries(bytes, ["word/media/image1.png"]).get("word/media/image1.png"));
  assert.ok(docxToText(bytes).text.includes("전체 구조"), "the caption survives");
});

test("a referenced asset nobody sent is refused by name, and prose images stay links", () => {
  assert.throws(
    () => renderDocx(parseMarkdown("![x](asset://missing.png)"), { title: "t", created: CREATED }),
    /asset:\/\/missing\.png/,
  );
  // Inside prose the image is an aside and remains a link — no bytes needed.
  const body = partOf(build("설명과 ![그림](asset://d.png) 문장"), "word/document.xml");
  assert.equal(body.includes("<w:drawing>"), false);
  assert.ok(body.includes("<w:hyperlink"));
});

test("a report with a cover and enough structure gets a contents page, complete as written", () => {
  const report = "# 보고서\n\n부제\n\n# 첫 장\n\n## 절\n\n내용\n\n# 둘째 장\n\n내용";
  const bytes = build(report);
  const body = partOf(bytes, "word/document.xml");
  // A field without page numbers (`\n`), so the renderer can compute the whole
  // result itself: nothing is left for Word to fill in, and nothing asks it
  // to — `updateFields` is what put a dialog in front of every reader.
  assert.ok(body.includes(' TOC \\o "1-2" \\h \\n '), "the TOC is a field, numbers omitted");
  assert.ok(body.includes('<w:fldChar w:fldCharType="separate"/>'), "the result is cached");
  assert.equal(partOf(bytes, "word/settings.xml").includes("updateFields"), false);
  const text = docxToText(bytes).text;
  assert.ok(text.includes("**목차**\n\n첫 장\n\n절\n\n둘째 장"), text);
});

test("the contents label follows the cover's language", () => {
  const english = build("# Quarterly Report\n\nsummary\n\n# One\n\n## Section\n\nbody\n\n# Two\n\nbody");
  assert.ok(docxToText(english).text.includes("Contents"));
});

test("a memo gets no contents page", () => {
  // Too little structure to list, or no cover at all: either way, no TOC.
  const short = build("# 메모\n\n한 줄\n\n## 하나\n\n내용");
  assert.equal(partOf(short, "word/document.xml").includes("TOC"), false);
  const coverless = build("## 하나\n\n내용\n\n## 둘\n\n내용\n\n## 셋\n\n내용");
  assert.equal(partOf(coverless, "word/document.xml").includes("TOC"), false);
});

test("a Korean document states its language; an English one adds no parts for it", () => {
  const korean = build("# 보고서\n\n한국어 본문");
  // themeFontLang and the run default are what point a non-Korean Word at its
  // Korean system face — no font is named, in keeping with the house rule.
  assert.ok(partOf(korean, "word/settings.xml").includes('<w:themeFontLang w:val="en-US" w:eastAsia="ko-KR"/>'));
  assert.ok(partOf(korean, "word/styles.xml").includes('<w:lang w:val="en-US" w:eastAsia="ko-KR"/>'));
  assert.equal(partOf(korean, "word/settings.xml").includes("updateFields"), false, "no dialog");
  const english = build("# Report\n\nEnglish body");
  assert.equal(listEntries(english).some((entry) => entry.name === "word/settings.xml"), false);
  assert.equal(partOf(english, "word/styles.xml").includes("<w:lang"), false);
});

test("in a Korean document the Latin follows the east-Asian face, still unnamed", () => {
  // Word otherwise splits a Korean sentence across two fonts — 한글 in the EA
  // default, "MCP" beside it in Calibri. The theme slot unifies them without
  // naming a face; an English document keeps Word's own split defaults.
  const korean = partOf(build("# 보고서\n\nMCP 기반 자동화"), "word/styles.xml");
  assert.ok(korean.includes('w:asciiTheme="minorEastAsia"'));
  const english = partOf(build("# Report\n\nplain body"), "word/styles.xml");
  assert.equal(english.includes("w:asciiTheme"), false);
});
