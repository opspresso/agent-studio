/**
 * PPTX generation, checked by reading it back.
 *
 * The same round trip the DOCX tests use, with one thing more to check: a deck
 * is a sequence of boxes, so *how many slides* and *what landed on which* are
 * part of the output rather than a detail of it. `read/pptx.ts` numbers the
 * slides it finds, which makes the assertion a plain string comparison.
 *
 * What it cannot check is whether PowerPoint calls the file valid — a manual
 * step. The structural assertions below stand in for the parts of it that
 * actually go wrong: a cell with no paragraph, a hyperlink with no relationship,
 * a slide with no layout behind it.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { detect } from "@/infrastructure/documents/engine/detect";
import { parseMarkdown, type Run } from "@/infrastructure/documents/engine/markdown";
import { pptxToText } from "@/infrastructure/documents/engine/read/pptx";
import { listEntries, readEntries } from "@/infrastructure/documents/engine/zip";
import { renderPptx } from "@/infrastructure/documents/engine/write/pptx/index";
import { BODY_BOX, BODY_SIZE, SLIDE_HEIGHT } from "@/infrastructure/documents/engine/write/pptx/layout";
import { decodeXmlEntities } from "@/infrastructure/documents/engine/xml";

const CREATED = "2026-08-13T00:00:00Z";

function build(markdown: string): Uint8Array {
  return renderPptx(parseMarkdown(markdown), { title: "test", created: CREATED }).bytes;
}

/** A 640×400 PNG header — all the size parser ever reads of a real file. */
function pngFixture(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, 640);
  new DataView(bytes.buffer).setUint32(20, 400);
  return bytes;
}

function roundTrip(markdown: string): string {
  return pptxToText(build(markdown)).text;
}

function partOf(bytes: Uint8Array, name: string): string {
  const part = readEntries(bytes, [name]).get(name);
  assert.ok(part, `expected the archive to hold ${name}`);
  return new TextDecoder().decode(part);
}

function bodyShapes(bytes: Uint8Array, slides: number): Array<{ xml: string; slide: number }> {
  return Array.from({ length: slides }, (_, index) => {
    const xml = partOf(bytes, `ppt/slides/slide${index + 1}.xml`);
    return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
      .filter(([shape]) => /name="Body \d+"/.test(shape))
      .map(([shape]) => ({ xml: shape, slide: index + 1 }));
  }).flat();
}

function assertBodyBounds(shapes: Array<{ xml: string; slide: number }>): void {
  assert.ok(shapes.length > 0, "the deck must contain body text boxes");
  for (const { xml, slide } of shapes) {
    const y = Number(/<a:off[^>]* y="(\d+)"/.exec(xml)?.[1]);
    const height = Number(/<a:ext[^>]* cy="(\d+)"/.exec(xml)?.[1]);
    assert.ok(y + height <= SLIDE_HEIGHT, `slide ${slide}: body ends at ${y + height}, outside ${SLIDE_HEIGHT}`);
    assert.ok(y >= BODY_BOX.y && y + height <= BODY_BOX.y + BODY_BOX.height, `slide ${slide}: text leaves the body area`);
  }
}

function bodyText(shapes: Array<{ xml: string }>): string {
  return shapes.flatMap(({ xml }) => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*>/g)]
    .map((match) => match[1] === undefined ? "\n" : decodeXmlEntities(match[1]))).join("");
}

test("a long single paragraph continues within real slide and body bounds without losing text", () => {
  const paragraph = "x".repeat(2000);
  const rendered = renderPptx(parseMarkdown(`## Long paragraph\n\n${paragraph}`), { title: "t", created: CREATED });
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assertBodyBounds(shapes);
  assert.ok(rendered.slides > 1);
  assert.equal(rendered.continuations, rendered.slides - 1);
  assert.equal(bodyText(shapes), paragraph);
});

test("splitting a styled paragraph preserves every code point, run property and hyperlink", () => {
  const runs: Run[] = [
    { text: "가😀".repeat(1000), bold: true, href: "https://example.test/source" },
    { text: "乙🚀".repeat(1000), italic: true, code: true },
    { text: " & <end> " },
  ];
  const rendered = renderPptx({ blocks: [{ kind: "heading", level: 2, runs: [{ text: "Styled" }] }, { kind: "paragraph", runs }] }, { title: "t", created: CREATED });
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assertBodyBounds(shapes);
  assert.ok(rendered.slides > 1);
  assert.equal(bodyText(shapes), runs.map((run) => run.text).join(""));
  const restored: Run[] = [];
  for (const { xml, slide } of shapes) {
    for (const match of xml.matchAll(/<a:r><a:rPr([^>]*)>([\s\S]*?)<\/a:rPr><a:t>([\s\S]*?)<\/a:t><\/a:r>/g)) {
      assert.match(match[1]!, new RegExp(`sz="${BODY_SIZE}"`), "body text must not shrink");
      const text = decodeXmlEntities(match[3]!);
      assert.ok(text.isWellFormed(), "a slide boundary must not split a surrogate pair");
      const linkId = /<a:hlinkClick[^>]* r:id="([^"]+)"/.exec(match[2]!)?.[1];
      const href = linkId ? new RegExp(`Id="${linkId}"[^>]*Target="([^"]+)"`).exec(partOf(rendered.bytes, `ppt/slides/_rels/slide${slide}.xml.rels`))?.[1] : undefined;
      if (linkId) assert.ok(href, "every continued hyperlink must resolve on its own slide");
      const run: Run = { text, ...(/ b="1"/.test(match[1]!) ? { bold: true } : {}), ...(/ i="1"/.test(match[1]!) ? { italic: true } : {}),
        ...(match[2]!.includes('typeface="Consolas"') ? { code: true } : {}), ...(href ? { href } : {}) };
      const previous = restored.at(-1);
      if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.code === run.code && previous.href === run.href) previous.text += run.text;
      else restored.push(run);
    }
  }
  assert.deepEqual(restored, runs);
});

test("explicit line breaks in a paragraph survive continuation and count toward the slide budget", () => {
  const text = Array.from({ length: 45 }, (_, index) => `line ${index}`).join("\n");
  const rendered = renderPptx({ blocks: [{ kind: "paragraph", runs: [{ text }] }] }, { title: "t", created: CREATED });
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assert.ok(rendered.slides > 1, "hard line breaks take vertical space even when text is narrow");
  assertBodyBounds(shapes);
  assert.equal(bodyText(shapes), text);
});

test("a split paragraph keeps the paragraphs before and after it separate", () => {
  const long = "body ".repeat(500);
  const rendered = renderPptx({ blocks: [
    { kind: "heading", level: 2, runs: [{ text: "Paragraphs" }] },
    ...["before", long, "after"].map((text) => ({ kind: "paragraph" as const, runs: [{ text }] })),
  ] }, { title: "t", created: CREATED });
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assertBodyBounds(shapes);
  const paragraphs = shapes.flatMap(({ xml }) => [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]).map(([xml]) => bodyText([{ xml }]));
  assert.equal(paragraphs[0], "before");
  assert.equal(paragraphs.at(-1), "after");
  assert.equal(paragraphs.slice(1, -1).join(""), long);
});

test("a long list item keeps one marker and does not recolour its continued text as a marker", () => {
  const item = "항목 ".repeat(700);
  const rendered = renderPptx({ blocks: [
    { kind: "heading", level: 2, runs: [{ text: "List" }] },
    { kind: "list", ordered: true, items: [{ depth: 0, runs: [{ text: item }] }, { depth: 0, runs: [{ text: "next" }] }] },
  ] }, { title: "t", created: CREATED });
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assertBodyBounds(shapes);
  assert.equal(bodyText(shapes), `1. ${item}2. next`);
  assert.ok(shapes.length > 2, "the test must inspect a continued middle fragment");
  const markerColour = /<a:srgbClr val="([^"]+)"/.exec(shapes[0]!.xml)?.[1];
  assert.ok(markerColour);
  for (const { xml } of shapes.slice(1, -1)) {
    assert.equal(xml.includes(`<a:srgbClr val="${markerColour}"`), false, "continued item text keeps its body colour");
  }
});

test("an oversized closing paragraph uses ordinary continuation slides instead of shrinking", () => {
  const text = "문의 내용 ".repeat(500);
  const rendered = renderPptx(parseMarkdown(`## 감사합니다\n\n${text}`), { title: "t", created: CREATED });
  assert.ok(rendered.slides > 1);
  const shapes = bodyShapes(rendered.bytes, rendered.slides);
  assertBodyBounds(shapes);
  assert.equal(bodyText(shapes), text.trimEnd());
  for (let slide = 1; slide <= rendered.slides; slide++) {
    assert.ok(partOf(rendered.bytes, `ppt/slides/_rels/slide${slide}.xml.rels`).includes("slideLayout2.xml"));
  }
});

test("a deck has the scaffolding its content types declare", () => {
  const bytes = build("# Title\n\nbody");
  const names = listEntries(bytes).map((entry) => entry.name).sort();
  assert.deepEqual(names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/presProps.xml",
    "ppt/presentation.xml",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    "ppt/slideLayouts/_rels/slideLayout2.xml.rels",
    "ppt/slideLayouts/_rels/slideLayout3.xml.rels",
    "ppt/slideLayouts/_rels/slideLayout4.xml.rels",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/slideLayouts/slideLayout2.xml",
    "ppt/slideLayouts/slideLayout3.xml",
    "ppt/slideLayouts/slideLayout4.xml",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slides/_rels/slide1.xml.rels",
    "ppt/slides/slide1.xml",
    "ppt/tableStyles.xml",
    "ppt/theme/theme1.xml",
    "ppt/viewProps.xml",
  ]);
  const types = partOf(bytes, "[Content_Types].xml");
  for (const declared of [
    "/ppt/presentation.xml",
    "/ppt/slideMasters/slideMaster1.xml",
    "/ppt/slides/slide1.xml",
    "/ppt/theme/theme1.xml",
    "/ppt/presProps.xml",
    "/ppt/viewProps.xml",
    "/ppt/tableStyles.xml",
  ]) {
    assert.ok(types.includes(declared), `content types should name ${declared}`);
  }
});

test("profiles change the deck theme and cover geometry", () => {
  const consulting = renderPptx(parseMarkdown("# 전략 제안"), {
    title: "test",
    created: CREATED,
    profile: "consulting",
  }).bytes;
  assert.ok(partOf(consulting, "ppt/theme/theme1.xml").includes('<a:dk2><a:srgbClr val="0B2D4D"/></a:dk2>'));
  assert.ok(partOf(consulting, "ppt/slideLayouts/slideLayout1.xml").includes('cx="457200"'));

  const formal = renderPptx(parseMarkdown("# 공식 보고서"), {
    title: "test",
    created: CREATED,
    profile: "formal",
  }).bytes;
  assert.equal(partOf(formal, "ppt/slideLayouts/slideLayout1.xml").includes('name="Band"'), false);
});

test("slides state their leading, zero tracking and kerning threshold", () => {
  const cover = partOf(build("# 여러 줄 표지 제목\n\n부제"), "ppt/slides/slide1.xml");
  assert.ok(cover.includes('<a:lnSpc><a:spcPct val="110000"/></a:lnSpc>'));
  assert.ok(cover.includes('<a:lnSpc><a:spcPct val="130000"/></a:lnSpc>'));
  assert.ok(cover.includes('kern="1200" spc="0"'));

  const content = partOf(build("## 제목\n\n여러 줄 본문"), "ppt/slides/slide1.xml");
  assert.ok(content.includes('<a:lnSpc><a:spcPct val="135000"/></a:lnSpc>'));
});

test("what this writes, this reads", () => {
  const bytes = build("# 제목\n\n## 첫째\n\n본문");
  assert.equal(detect(bytes, "", "deck.pptx").format, "pptx");
});

test("a level 1 or 2 heading opens a slide and becomes its title", () => {
  const rendered = renderPptx(parseMarkdown("# 표지\n\n## 하나\n\na\n\n## 둘\n\nb"), {
    title: "t",
    created: CREATED,
  });
  assert.equal(rendered.slides, 3);
  assert.equal(
    pptxToText(rendered.bytes).text,
    "## Slide 1\n\n### 표지\n\n## Slide 2\n\n### 하나\n\na\n\n## Slide 3\n\n### 둘\n\nb",
  );
});

test("a level 3 heading stays in the body rather than opening a slide", () => {
  assert.equal(roundTrip("## 하나\n\n### 안쪽\n\n본문"), "## Slide 1\n\n### 하나\n\n**안쪽**\n\n본문");
});

test("the deck opens on a cover only when the document does", () => {
  // A `#` at the top is a cover and takes the title layout; the same heading
  // halfway down is a section divider, which has a layout of its own.
  const cover = build("# 표지\n\n## 다음");
  assert.ok(partOf(cover, "ppt/slides/_rels/slide1.xml.rels").includes("slideLayout1.xml"));
  assert.ok(partOf(cover, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout2.xml"));
  const plain = build("본문\n\n# 나중 제목");
  assert.ok(partOf(plain, "ppt/slides/_rels/slide1.xml.rels").includes("slideLayout2.xml"));
  assert.ok(partOf(plain, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout3.xml"));
});

test("every slide is registered in the presentation, and every one has a layout", () => {
  const bytes = build("## a\n\n## b\n\n## c");
  const presentation = partOf(bytes, "ppt/presentation.xml");
  assert.equal(presentation.match(/<p:sldId /g)?.length, 3);
  const rels = partOf(bytes, "ppt/_rels/presentation.xml.rels");
  for (let slide = 1; slide <= 3; slide += 1) {
    assert.ok(rels.includes(`Target="slides/slide${slide}.xml"`));
    assert.ok(partOf(bytes, `ppt/slides/_rels/slide${slide}.xml.rels`).includes("slideLayout"));
  }
});

test("styled text keeps its characters, and the styling is in the markup", () => {
  const bytes = build("## s\n\nplain **bold** and *italic* and `code`");
  assert.ok(pptxToText(bytes).text.includes("plain **bold** and *italic* and code"));
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes(' b="1"'), "bold should be a run property");
  assert.ok(slide.includes(' i="1"'), "italic should be a run property");
  assert.ok(slide.includes('<a:latin typeface="Consolas"/>'), "code should change the face");
});

test("a link is a run property with a relationship behind it", () => {
  const bytes = build("## s\n\nsee [the spec](https://example.com/s)");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  const id = /<a:hlinkClick[^>]* r:id="(rId\d+)"/.exec(slide)?.[1];
  assert.ok(id, "the link should be an a:hlinkClick");
  const rels = partOf(bytes, "ppt/slides/_rels/slide1.xml.rels");
  assert.ok(
    rels.includes(`Id="${id}"`) && rels.includes('Target="https://example.com/s"'),
    "the hyperlink id must resolve to an external relationship",
  );
});

test("the same target twice reuses its relationship", () => {
  const bytes = build("## s\n\n[a](https://example.com) and [b](https://example.com)");
  const rels = partOf(bytes, "ppt/slides/_rels/slide1.xml.rels");
  assert.equal(rels.match(/Type="[^"]*\/hyperlink"/g)?.length, 1);
});

test("a table's graphicData carries the one URI PowerPoint knows tables by", () => {
  // `.../drawingml/2006/table` — the namespace with `main` swapped out, not
  // appended to. This assertion exists because the appended form shipped:
  // schema-valid, accepted by five other parsers, and PowerPoint's repair
  // flow gutted every slide that contained a table.
  const slide = partOf(build("## s\n\n| a | b |\n|---|---|\n| 1 | 2 |"), "ppt/slides/slide1.xml");
  assert.ok(
    slide.includes('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'),
    "the graphicData uri must be the drawingml table URI, with no /main/ in it",
  );
});

test("a table names the default style, and the style part defines it", () => {
  const bytes = build("## s\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  const id = /<a:tableStyleId>(\{[0-9A-F-]+\})<\/a:tableStyleId>/.exec(slide)?.[1];
  assert.ok(id, "every native table names a style; one that does not reads as damage");
  assert.ok(partOf(bytes, "ppt/tableStyles.xml").includes(`def="${id}"`));
});

test("a table becomes a table, and every cell has a paragraph in it", () => {
  const bytes = build("## s\n\n| 이름 | 값 |\n|---|---|\n| a | 1 |\n| b |  |");
  assert.ok(pptxToText(bytes).text.includes("| **이름** | **값** |\n| --- | --- |\n| a | 1 |\n| b |  |"));
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes("<a:tbl>"), "a table should be a graphic frame holding a:tbl");
  // A cell with no paragraph in it is what makes PowerPoint call a file corrupt.
  assert.equal(/<a:tc>(?:(?!<a:p[ />]).)*<\/a:tc>/s.test(slide), false);
});

test("a column asked to be set right is set right", () => {
  // Scoped to the table: the slide-number field is right-aligned too, and
  // counting it would make this pass for the wrong reason.
  const tableOf = (markdown: string): string =>
    /<a:tbl>[\s\S]*<\/a:tbl>/.exec(partOf(build(markdown), "ppt/slides/slide1.xml"))?.[0] ?? "";
  const aligned = tableOf("## s\n\n| a | n |\n|---|---:|\n| x | 42 |");
  assert.equal(aligned.match(/algn="r"/g)?.length, 2, "header and cell both move");
  const plain = tableOf("## s\n\n| a | n |\n|---|---|\n| x | 42 |");
  assert.equal(plain.includes('algn="r"'), false);
});

test("every shape carries a text body, empty or not", () => {
  // `p:txBody` is `minOccurs="0"` in the schema and mandatory in practice:
  // PowerPoint calls a `p:sp` without one damaged and offers to repair the file.
  const slide = partOf(build("# 표지\n\n## 본문\n\n내용"), "ppt/slides/slide2.xml");
  assert.equal(
    /<p:sp>(?:(?!<\/p:sp>|<p:txBody>)[\s\S])*<\/p:sp>/.test(slide),
    false,
    "a shape with no p:txBody makes PowerPoint offer a repair",
  );
});

test("a slide is numbered by a field whose cached text stays out of extraction", () => {
  const bytes = build("# 표지\n\n## 본문\n\n내용");
  const numbered = partOf(bytes, "ppt/slides/slide2.xml");
  // The cached `a:t` is what every native fld carries; a field without one is
  // a shape PowerPoint never writes, and Windows PowerPoint reads never-written
  // shapes as damage.
  assert.match(numbered, /<a:fld id="\{[0-9A-F-]+\}" type="slidenum">[\s\S]*?<a:t>2<\/a:t><\/a:fld>/);
  assert.equal(
    partOf(bytes, "ppt/slides/slide1.xml").includes("slidenum"),
    false,
    "the cover is not numbered",
  );
  // The reader skips fld contents, so the cache never reaches the model.
  assert.equal(pptxToText(bytes).text, "## Slide 1\n\n### 표지\n\n## Slide 2\n\n### 본문\n\n내용");
});

test("lists carry their markers, and a nested list numbers from one", () => {
  assert.equal(roundTrip("## s\n\n- one\n- two"), "## Slide 1\n\n### s\n\n- one\n- two");
  assert.equal(
    roundTrip("## s\n\n1. a\n  1. a.1\n  2. a.2\n2. b"),
    // The numbers are the ones the deck drew: a nested run restarts at 1 and
    // says so, rather than being renumbered into a single flat list.
    "## Slide 1\n\n### s\n\n1. a\n\n1. a.1\n2. a.2\n\n2. b",
  );
});

test("content past the bottom continues on the next slide, titled as such", () => {
  const items = Array.from({ length: 20 }, (_, index) => `- 항목 ${index + 1}`).join("\n");
  const rendered = renderPptx(parseMarkdown(`## 목록\n\n${items}`), {
    title: "t",
    created: CREATED,
  });
  assert.equal(rendered.slides, 2);
  const text = pptxToText(rendered.bytes).text;
  assert.ok(text.includes("## Slide 2\n\n### 목록 (계속)"), text);
  // Nothing is dropped in the move: every item is on one slide or the other.
  for (let item = 1; item <= 20; item += 1) {
    assert.ok(text.includes(`- 항목 ${item}\n`) || text.endsWith(`- 항목 ${item}`));
  }
});

test("a numbered list split across slides keeps counting", () => {
  // The marker is resolved before the deck is packed, which is the whole reason
  // it can: a second list block would start again at 1.
  const items = Array.from({ length: 20 }, (_, index) => `${index + 1}. 항목`).join("\n");
  const text = pptxToText(build(`## 목록\n\n${items}`)).text;
  assert.ok(text.includes("15. 항목"), text);
  assert.equal(text.match(/\n1\. 항목/g)?.length, 1, "only the first item is numbered 1");
});

test("a table too tall for one slide splits by row, with its header repeated", () => {
  const rows = Array.from({ length: 20 }, (_, index) => `| 행 ${index + 1} | ${index} |`).join("\n");
  const rendered = renderPptx(parseMarkdown(`## 표\n\n| 이름 | 값 |\n|---|---|\n${rows}`), {
    title: "t",
    created: CREATED,
  });
  assert.ok(rendered.slides > 1, "twenty rows should not fit on one slide");
  const text = pptxToText(rendered.bytes).text;
  assert.equal(
    text.match(/\| \*\*이름\*\* \| \*\*값\*\* \|/g)?.length,
    rendered.slides,
    "each slide repeats the header",
  );
  assert.ok(text.includes("행 20"), "no row is lost in the split");
});

test("a table moves to the next slide when its header and first row exceed the remaining room", () => {
  const paragraphs = Array.from({ length: 13 }, (_, index) => `paragraph ${index}`).join("\n\n");
  const rendered = renderPptx(parseMarkdown(`${paragraphs}\n\n| Header |\n|---|\n| first |\n| second |`), { title: "t", created: CREATED });
  assertBodyBounds(bodyShapes(rendered.bytes, rendered.slides));
  const tables = Array.from({ length: rendered.slides }, (_, index) =>
    [...partOf(rendered.bytes, `ppt/slides/slide${index + 1}.xml`).matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)]
      .map(([xml]) => ({ xml, slide: index + 1 }))).flat();
  assertBodyBounds(tables);
  assert.equal(tables.length, 1, "a small table should stay together on the following slide");
  assert.equal(tables[0]?.slide, 2);
  assert.equal(bodyText(tables), "Headerfirstsecond");
});

test("a code block keeps its lines", () => {
  assert.equal(
    roundTrip("## s\n\n```ts\nconst a = 1;\nconst b = 2;\n```"),
    "## Slide 1\n\n### s\n\nconst a = 1;\n\nconst b = 2;",
  );
});

test("XML metacharacters in the text do not become markup", () => {
  assert.equal(
    roundTrip('## s\n\na < b & c > d "quoted"'),
    '## Slide 1\n\n### s\n\na < b & c > d "quoted"',
  );
});

test("the title lands in the document properties, escaped", () => {
  const bytes = renderPptx(parseMarkdown("body"), {
    title: "A & B <deck>",
    created: CREATED,
  }).bytes;
  const core = partOf(bytes, "docProps/core.xml");
  assert.ok(core.includes("<dc:title>A &amp; B &lt;deck&gt;</dc:title>"));
  assert.ok(core.includes(CREATED));
});

test("the file records what wrote it", () => {
  assert.match(partOf(build("## s"), "docProps/app.xml"), /<Application>Agent Studio \d+\.\d+\.\d+<\/Application>/);
});

test("the same input twice produces the same bytes", () => {
  assert.deepEqual(build("## same\n\ntext"), build("## same\n\ntext"));
});

test("an empty document is still a deck of one slide", () => {
  const rendered = renderPptx({ blocks: [] }, { title: "empty", created: CREATED });
  assert.equal(rendered.slides, 1);
  const slide = partOf(rendered.bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes("<p:spTree>"));
  assert.ok(slide.includes("<a:p>"), "an empty slide still has a paragraph to select");
});

test("a mid-document # is a numbered divider, and its content follows it", () => {
  const rendered = renderPptx(
    parseMarkdown("# 표지\n\n# 첫 장\n\n내용 하나\n\n# 둘째 장"),
    { title: "t", created: CREATED },
  );
  // Cover, divider 01, its content, divider 02.
  assert.equal(rendered.slides, 4);
  const text = pptxToText(rendered.bytes).text;
  // The divider number is a bold line of its own above the section title.
  assert.ok(text.includes("## Slide 2\n\n**01**\n\n### 첫 장"), text);
  assert.ok(text.includes("## Slide 3\n\n### 첫 장\n\n내용 하나"), text);
  assert.ok(text.includes("## Slide 4\n\n**02**\n\n### 둘째 장"), text);
  // The divider takes the section layout; its content slide does not.
  assert.ok(partOf(rendered.bytes, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout3.xml"));
  assert.ok(partOf(rendered.bytes, "ppt/slides/_rels/slide3.xml.rels").includes("slideLayout2.xml"));
});

test("a cover keeps its subtitle and sends everything else onward", () => {
  const rendered = renderPptx(
    parseMarkdown("# 제목\n\n부제목 한 줄\n\n- 항목 하나\n- 항목 둘"),
    { title: "t", created: CREATED },
  );
  assert.equal(rendered.slides, 2, "the list moves past the cover");
  const text = pptxToText(rendered.bytes).text;
  assert.ok(text.includes("## Slide 1\n\n### 제목\n\n부제목 한 줄"), text);
  assert.ok(text.includes("## Slide 2\n\n- 항목 하나"), text);
});

test("a final thank-you section is a closing slide; the same title mid-deck is not", () => {
  const closing = build("# 표지\n\n## 본론\n\n내용\n\n## 감사합니다\n\n문의: docs@example.com");
  assert.ok(partOf(closing, "ppt/slides/_rels/slide3.xml.rels").includes("slideLayout4.xml"));
  // Mid-deck, the same heading is an ordinary content slide.
  const middle = build("# 표지\n\n## 감사합니다\n\n내용\n\n## 다음 주제\n\n본문");
  assert.ok(partOf(middle, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout2.xml"));
});

test("closing slide recognition matches a whole closing phrase", () => {
  for (const title of ["Qatar expansion", "질문 처리 절차", "Thanks to our partners"]) {
    const bytes = build(`# Cover\n\n## ${title}\n\nContent`);
    assert.ok(partOf(bytes, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout2.xml"), title);
  }
  const closing = build("# Cover\n\n## Thank you!");
  assert.ok(partOf(closing, "ppt/slides/_rels/slide2.xml.rels").includes("slideLayout4.xml"));
});

test("the deck's name sits on the content layout, out of the slides' text", () => {
  const bytes = renderPptx(parseMarkdown("## 본문\n\n내용"), {
    title: "분기 보고서",
    created: CREATED,
  }).bytes;
  assert.ok(
    partOf(bytes, "ppt/slideLayouts/slideLayout2.xml").includes("분기 보고서"),
    "the footer names the deck on the layout",
  );
  assert.equal(
    pptxToText(bytes).text.includes("분기 보고서"),
    false,
    "layout text must stay out of extraction",
  );
});

test("a cards section renders one rounded shape per card, carrying its own text", () => {
  const bytes = build("## 핵심 가치\n\n### Automation\n\n반복 작업 자동화\n\n### Integration\n\nMCP 기반 연결");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.match(/prst="roundRect"/g)?.length, 2, "one roundRect per card");
  // The card is the shape and the text is inside it: dragging one drags both.
  assert.match(slide, /roundRect[\s\S]*?Automation/);
  assert.ok(pptxToText(bytes).text.includes("**Automation**\n\n반복 작업 자동화"));
});

test("a metrics section sets the figure large and the label under it", () => {
  const bytes = build("## 주요 성과\n\n- 99.99% Availability\n- 43% Cost Reduction");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes('sz="4400"'), "the figure takes the metric size");
  const text = pptxToText(bytes).text;
  assert.ok(text.includes("99.99%"), text);
  assert.ok(text.includes("Availability"), text);
});

test("a lone quote gets the quote treatment and keeps its words", () => {
  const bytes = build("## 고객의 말\n\n> 반복 업무가 사라졌다.\n\n— 운영팀 리드");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes(' i="1"'), "the quote is set in italic");
  assert.ok(pptxToText(bytes).text.includes("반복 업무가 사라졌다."));
  assert.ok(pptxToText(bytes).text.includes("— 운영팀 리드"));
});

test("a comparison renders two chips with the column lines beneath", () => {
  const bytes = build(
    "## IRSA vs Pod Identity\n\n### IRSA\n\n- 표준 방식\n\n### Pod Identity\n\n- 신규 권장",
  );
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.match(/prst="roundRect"/g)?.length, 2, "one chip per column");
  const text = pptxToText(bytes).text;
  assert.ok(text.indexOf("IRSA") < text.indexOf("표준 방식"), "chip precedes its lines");
  assert.ok(text.includes("- 신규 권장"), text);
});

test("a comparison containing numbered steps preserves them as a list", () => {
  const body = "### A\n\n1. first\n2. second\n\n### B\n\n- other";
  for (const source of [body, `:::comparison\n${body}\n:::`]) {
    const text = roundTrip(`## A vs B\n\n${source}`);
    assert.ok(text.includes("1. first\n2. second"), text);
  }
});

test("a process is a row of nodes with arrows between, reading back as the list it was", () => {
  const bytes = build("## 절차\n\n1. 접수\n2. 검토\n3. 발송");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.match(/prst="roundRect"/g)?.length, 3, "one node per step");
  assert.equal(slide.match(/prst="rightArrow"/g)?.length, 2, "an arrow in each gap");
  const text = pptxToText(bytes).text;
  assert.ok(text.includes("1. 접수"), text);
  assert.ok(text.includes("3. 발송"), text);
});

test("a timeline draws stations on a line, the dates above and the work below", () => {
  const bytes = build("## 로드맵\n\n1. Q1 파일럿\n2. Q2 확대\n3. Q3 전사 배포");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.match(/prst="ellipse"/g)?.length, 3, "a dot per station");
  const text = pptxToText(bytes).text;
  assert.ok(text.indexOf("Q1") < text.indexOf("파일럿"), "the date leads its milestone");
  assert.ok(text.includes("전사 배포"), text);
});

test("a directive forces its archetype past the guards recognition keeps", () => {
  // No "vs" in the title, so recognition alone would make cards of this; the
  // directive says comparison and the shape can form one.
  const bytes = build(
    "## 인증 방식\n\n:::comparison\n### IRSA\n\n- 표준\n\n### Pod Identity\n\n- 신규 권장\n:::",
  );
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.match(/prst="roundRect"/g)?.length, 2, "two chips, so a comparison");
});

test("a directive whose contents cannot form the archetype falls back to content", () => {
  // Six steps do not fit a process row however clearly it was requested.
  const bytes = build("## 절차\n\n:::process\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n:::");
  const slide = partOf(bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.includes('prst="rightArrow"'), false, "no arrows: it fell back");
  assert.ok(pptxToText(bytes).text.includes("6. f"), "nothing was dropped in the fall");
});

test("an overflowing slide breaks before the last sub-heading, which titles the continuation", () => {
  const filler = Array.from({ length: 10 }, (_, index) => `- 항목 ${index + 1}`).join("\n");
  const text = roundTrip(
    `## 아키텍처\n\n${filler}\n\n### Control Plane\n\n- 정책 관리\n- 감사 로그\n- 변경 승인`,
  );
  // The topic moved whole: its heading is now the continuation's title, and
  // nothing of it stayed behind on the first slide.
  assert.ok(text.includes("## Slide 2\n\n### 아키텍처 — Control Plane\n\n- 정책 관리"), text);
  assert.equal(text.includes("(계속)"), false, text);
});

test("an image section embeds the picture and captions it with the alt text", () => {
  const rendered = renderPptx(
    parseMarkdown("## 아키텍처 다이어그램\n\n![전체 구조](asset://diagram.png)"),
    { title: "t", created: CREATED, assets: { "diagram.png": { mimeType: "image/png", bytes: pngFixture() } } },
  );
  const slide = partOf(rendered.bytes, "ppt/slides/slide1.xml");
  assert.ok(slide.includes("<p:pic>"), "the image is a native picture");
  const embed = /<a:blip r:embed="(rId\d+)"\/>/.exec(slide)?.[1];
  assert.ok(embed, "the blip names a relationship");
  const rels = partOf(rendered.bytes, "ppt/slides/_rels/slide1.xml.rels");
  assert.ok(rels.includes(`Id="${embed}"`) && rels.includes("../media/image1.png"));
  assert.ok(partOf(rendered.bytes, "[Content_Types].xml").includes('Extension="png"'));
  assert.ok(readEntries(rendered.bytes, ["ppt/media/image1.png"]).get("ppt/media/image1.png"));
  assert.ok(pptxToText(rendered.bytes).text.includes("전체 구조"), "the caption survives");
  assert.ok(pptxToText(rendered.bytes).text.includes("ppt/media/image1.png"), "the image resolves to its actual part");
});

test("a referenced asset that was not provided is refused by name", () => {
  assert.throws(
    () =>
      renderPptx(parseMarkdown("## 그림\n\n![x](asset://missing.png)"), {
        title: "t",
        created: CREATED,
      }),
    /asset:\/\/missing\.png/,
  );
});

test("an image inside prose stays a link, as every image used to be", () => {
  const rendered = renderPptx(
    parseMarkdown("## 본문\n\n설명이 있고 ![그림](asset://d.png) 이어진다\n\n다음 문단"),
    { title: "t", created: CREATED, assets: { "d.png": { mimeType: "image/png", bytes: pngFixture() } } },
  );
  const slide = partOf(rendered.bytes, "ppt/slides/slide1.xml");
  assert.equal(slide.includes("<p:pic>"), false, "no picture: the image was an aside");
  assert.ok(slide.includes("hlinkClick"), "it is still reachable as a link");
});

test("the divider's ground and the cover's band are layout furniture, not slide shapes", () => {
  const bytes = build("# 표지\n\n# 장");
  // The section layout carries the brand field; the divider slide itself only
  // carries text, so a reader editing it never steps around furniture.
  assert.ok(partOf(bytes, "ppt/slideLayouts/slideLayout3.xml").includes('<p:bg>'));
  assert.equal(partOf(bytes, "ppt/slides/slide2.xml").includes("<p:bg>"), false);
  assert.ok(partOf(bytes, "ppt/slideLayouts/slideLayout1.xml").includes('name="Band"'));
});

test("accent rules belong to transition layouts, never content slides", () => {
  const plain = partOf(build("## 결론\n\n본문"), "ppt/slides/slide1.xml");
  const comparison = partOf(
    build("## A vs B\n\n### A\n\n- 하나\n\n### B\n\n- 둘"),
    "ppt/slides/slide1.xml",
  );
  assert.equal(plain.includes('name="Accent '), false);
  assert.equal(comparison.includes('name="Accent '), false);

  const layouts = build("# 표지\n\n# 장\n\n## 감사합니다");
  for (const index of [1, 3, 4]) {
    assert.match(partOf(layouts, `ppt/slideLayouts/slideLayout${index}.xml`), /name="Rule \d+"/);
  }
});

test("a run of 한글 is labelled ko-KR, and Latin stays en-US", () => {
  // The language is the one signal PowerPoint has for picking its east-Asian
  // default face, since no face is ever named for prose.
  const slide = partOf(build("## 분기 보고\n\n한국어 본문과 English text"), "ppt/slides/slide1.xml");
  assert.match(slide, /<a:rPr lang="ko-KR"[^>]*>(?:(?!<\/a:r>).)*분기 보고/s);
  assert.ok(slide.includes('lang="ko-KR"'), "Korean runs carry their language");
  assert.ok(slide.includes('lang="en-US"'), "Latin-only runs keep the default");
});
