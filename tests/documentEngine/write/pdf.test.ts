/**
 * PDF generation, checked by extracting the text back out with the same reader
 * this server offers.
 *
 * The assertions are on content and structure rather than on exact layout: a
 * PDF's text comes back in the order it was drawn, broken at the lines this
 * renderer chose, so pinning the whole string would pin every measurement to a
 * font's metrics. What matters is that everything written is in there, that
 * Korean survives at all — the entire reason a font is embedded — and that the
 * layout terminates on inputs designed to make it not.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { PDFDocument } from "pdf-lib";
import { columnWidths, renderPdf, usesBold } from "@/infrastructure/documents/engine/write/pdf";

const CREATED = new Date("2026-08-05T00:00:00Z");

/**
 * `unpdf` directly, rather than through a reader of ours.
 *
 * The PDF *reader* left with the URL side — the caller extracts PDFs in-process
 * and routing one here would have been a network round trip to reach this same
 * library. The round trip is still the only honest check that what this writes
 * is a PDF something can read, so the test keeps the dependency the source no
 * longer needs.
 */
/**
 * `Math.sumPrecise` is a TC39 proposal no Node this runs on has. The PDF.js
 * build inside `unpdf` calls it while rebuilding an embedded font's glyph
 * tables, so every font throws a TypeError it catches and reports as a warning —
 * one line per font, which buries everything else in the test output. Neumaier
 * summation is more than enough for glyph byte counts, and it is installed only
 * if absent so a future runtime's own wins.
 *
 * It lived beside the PDF *reader* until that left with the URL side; only this
 * round trip still needs it.
 */
const math = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
if (typeof math.sumPrecise !== "function") {
  math.sumPrecise = (values) => {
    let sum = 0;
    let compensation = 0;
    for (const value of values) {
      const next = sum + value;
      compensation +=
        Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

/**
 * Page by page, joined the way the reader that used to live here did — a merged
 * extract loses the line structure one of these tests is entirely about.
 */
async function extractLines(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.join("\n\n");
}

async function roundTrip(markdown: string): Promise<string> {
  const { bytes } = await renderPdf(parseMarkdown(markdown), { title: "test", created: CREATED });
  const text = await extractLines(bytes);
  // Line breaks are the renderer's, not the document's, so they are not what
  // these assertions are about.
  return text.replace(/\s+/g, " ").trim();
}

test("what goes in comes back out", async () => {
  const text = await roundTrip("# Title\n\nA paragraph of body text.\n\n- one\n- two");
  assert.match(text, /Title/);
  assert.match(text, /A paragraph of body text\./);
  assert.match(text, /one/);
  assert.match(text, /two/);
});

test("profiles change the rendered PDF without changing its text", async () => {
  const document = parseMarkdown("# 보고서\n\n## 결론\n\n진행한다.");
  const executive = await renderPdf(document, { title: "test", created: CREATED, profile: "executive" });
  const formal = await renderPdf(document, { title: "test", created: CREATED, profile: "formal" });
  assert.notDeepEqual(executive.bytes, formal.bytes);
  assert.equal(
    (await extractLines(executive.bytes)).replace(/\s+/g, " ").trim(),
    (await extractLines(formal.bytes)).replace(/\s+/g, " ").trim(),
  );
});

test("Korean survives, which is the whole reason a font is embedded", async () => {
  // With one of PDF's built-in fonts this comes back empty or as a row of
  // boxes: they encode Latin-1 and nothing else.
  const text = await roundTrip("# 분기 보고서\n\n한글 본문이 그대로 남아 있어야 한다.");
  assert.match(text, /분기 보고서/);
  assert.match(text, /한글 본문이 그대로 남아 있어야 한다/);
});

test("the Hangul face is embedded whole, because subsetting it loses glyphs", async () => {
  // The regression, and the reason this is asserted on size rather than on
  // content: `@pdf-lib/fontkit`'s subsetter drops most Hangul glyphs *silently*.
  // The text layer stays perfect, so the round trip above passes either way and
  // the page shows blanks where two thirds of the characters should be. A
  // whole face is the only thing that distinguishes the two, and its weight is
  // the only thing a test can see.
  const { bytes } = await renderPdf(parseMarkdown("한글 문서"), { title: "t", created: CREATED });
  assert.ok(
    bytes.byteLength > 400_000,
    `expected a whole embedded face, got ${bytes.byteLength} bytes — subsetting is back`,
  );
});

test("the bold face is embedded only when something is bold", async () => {
  const plain = await renderPdf(parseMarkdown("본문뿐인 문서"), { title: "t", created: CREATED });
  const bold = await renderPdf(parseMarkdown("# 제목\n\n본문뿐인 문서"), {
    title: "t",
    created: CREATED,
  });
  assert.ok(usesBold(parseMarkdown("# 제목")), "a heading is bold");
  assert.equal(usesBold(parseMarkdown("본문")), false);
  assert.ok(
    bold.bytes.byteLength > plain.bytes.byteLength * 1.5,
    "the document with a heading should carry a second face",
  );
});

test("bold inside a directive still embeds the bold face", async () => {
  // A `:::` fence has no treatment on a page, so its contents are rendered
  // where it stood — and the walk that decides whether to embed the bold face
  // did not look inside one. Everything this renderer bolds came out at body
  // weight, silently: the text extracts perfectly and only looks wrong.
  const cards = "# 제목\n\n:::cards\n\n### 하나\n\n**굵게** 쓴 문장.\n\n### 둘\n\n짧은 설명.\n\n:::";
  assert.ok(usesBold(parseMarkdown(":::cards\n\n### 하나\n\n짧은 설명.\n\n:::")));
  assert.ok(usesBold(parseMarkdown(":::metrics\n\n- **99.9%** 가용성\n\n:::")));
  assert.equal(usesBold(parseMarkdown(":::cards\n\n본문뿐인 문단.\n\n:::")), false);

  const plain = await renderPdf(parseMarkdown("본문뿐인 문서"), { title: "t", created: CREATED });
  const directive = await renderPdf(parseMarkdown(cards), { title: "t", created: CREATED });

  assert.ok(
    directive.bytes.byteLength > plain.bytes.byteLength * 1.5,
    "a heading inside a directive should still carry a second face",
  );
});

test("a long Korean paragraph wraps instead of running off the page", async () => {
  // Korean prose has no spaces to break at, so a breaker that waits for one
  // produces a single line the width of the document.
  const sentence = "이 문장은 공백 없이".replace(/ /g, "") .repeat(60);
  const { bytes } = await renderPdf(parseMarkdown(sentence), { title: "t", created: CREATED });
  const text = await extractLines(bytes);
  assert.ok(text.includes("\n"), "the paragraph should have been broken across lines");
  assert.equal(text.replace(/\s+/g, ""), sentence);
});

test("a document longer than a page gets more pages", async () => {
  const long = Array.from({ length: 120 }, (_, index) => `Paragraph number ${index}.`).join("\n\n");
  const { pages } = await renderPdf(parseMarkdown(long), { title: "t", created: CREATED });
  assert.ok(pages > 1, `expected more than one page, got ${pages}`);
});

test("tables, code, quotes and rules all render without losing their text", async () => {
  const text = await roundTrip(
    "| 이름 | 값 |\n|---|---|\n| 가 | 1 |\n\n```\nconst a = 1;\n```\n\n> 인용문\n\n---\n\n끝",
  );
  for (const expected of ["이름", "값", "가", "1", "const a = 1;", "인용문", "끝"]) {
    assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in the output`);
  }
});

test("a link is one clickable annotation, not one per word", async () => {
  const { bytes } = await renderPdf(parseMarkdown("see [the whole spec](https://example.com/s)"), {
    title: "t",
    created: CREATED,
  });
  // Read back rather than searched for as text: pdf-lib saves with object
  // streams, so every dictionary in the file is inside a Flate stream.
  const loaded = await PDFDocument.load(bytes);
  const annotations = loaded.getPage(0).node.Annots();
  // Colouring text blue only makes it look like a link; the annotation is what
  // makes clicking it do something — and three words must not become three
  // links with dead gaps between them.
  assert.equal(annotations?.size(), 1);
  assert.match(annotations!.toString(), /\d+ 0 R/);
});

test("a standalone asset image is embedded and a missing one is refused", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  const rendered = await renderPdf(parseMarkdown("![구조도](asset://diagram.png)"), {
    title: "t",
    created: CREATED,
    assets: { "diagram.png": { mimeType: "image/png", bytes: png } },
  });
  const loaded = await PDFDocument.load(rendered.bytes);
  const imageObjects = loaded.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object.toString().includes("/Subtype /Image"));
  assert.ok(imageObjects.length > 0, "the PDF should carry an image XObject");

  await assert.rejects(
    () =>
      renderPdf(parseMarkdown("![구조도](asset://missing.png)"), {
        title: "t",
        created: CREATED,
      }),
    /asset:\/\/missing\.png/,
  );
});

test("a word wider than the page gets its own line rather than an endless loop", async () => {
  const text = await roundTrip(`start ${"x".repeat(400)} end`);
  assert.match(text, /start/);
  assert.match(text, /end/);
});

test("long code lines retain every character within the page width", async () => {
  for (const source of ["abc123_".repeat(60) + "END", "한글코드".repeat(80) + "끝"]) {
    const { bytes } = await renderPdf(parseMarkdown("```\n" + source + "\n```"), {
      title: "Code", created: CREATED,
    });
    const text = await extractLines(bytes);
    assert.equal(text.replace(/\s/g, ""), source);
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if ("str" in item && item.str.trim()) {
        assert.ok(item.transform[4] + item.width < 540, "code stays inside the right margin");
      }
    }
  }
});

test("the file records what wrote it", async () => {
  const { bytes } = await renderPdf(parseMarkdown("body"), { title: "t", created: CREATED });
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { info } = (await pdf.getMetadata()) as unknown as { info: Record<string, unknown> };
  // Both fields: readers disagree about which they show.
  assert.match(String(info.Producer), /^Agent Studio \d+\.\d+\.\d+$/);
  assert.match(String(info.Creator), /^Agent Studio \d+\.\d+\.\d+$/);
});

test("an empty document is still a valid PDF", async () => {
  const { bytes, pages } = await renderPdf({ blocks: [] }, { title: "empty", created: CREATED });
  assert.equal(pages, 1);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("latin1"), "%PDF");
});

test("a cover-only PDF does not append an empty body page", async () => {
  const { bytes, pages } = await renderPdf(parseMarkdown("# Title\n\nSubtitle"), {
    title: "Title", created: CREATED,
  });
  assert.equal(pages, 1);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  const text = await extractLines(bytes);
  assert.ok(text.includes("Title") && text.includes("Subtitle"));
});

test("column widths follow the content and stay inside their clamps", () => {
  const cell = (text: string) => [[{ text }]];
  const rows = [
    [[{ text: "id" }], [{ text: "description" }]],
    [[{ text: "1" }], [{ text: "a much longer piece of prose in this column" }]],
  ];
  const widths = columnWidths(rows, 2);
  assert.ok(widths[1]! > widths[0]!, "the wider column should get more room");
  const total = widths.reduce((sum, width) => sum + width, 0);
  assert.ok(Math.abs(total - 481.88) < 1, `columns should fill the content width, got ${total}`);
  // One enormous cell must not squeeze the others to nothing.
  const lopsided = columnWidths([[cell("a")[0]!, [{ text: "x".repeat(5000) }]]], 2);
  assert.ok(lopsided[0]! / total > 0.05, "the small column keeps a usable share");
});

test("a report gets a cover, a contents page with real page numbers, and numbered chapters", async () => {
  const report =
    "# 도입 보고서\n\n부제 한 줄\n\n# 첫 장\n\n" +
    "본문\n\n# 둘째 장\n\n## 절\n\n내용";
  const { bytes, pages } = await renderPdf(parseMarkdown(report), {
    title: "t",
    created: CREATED,
  });
  assert.ok(pages >= 4, `cover, contents and two chapter pages: got ${pages}`);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pageOf = (needle: string): number => text.findIndex((page) => page.includes(needle)) + 1;
  assert.equal(pageOf("도입 보고서"), 1, "the cover leads");
  assert.equal(pageOf("목차"), 2, "the contents page follows it");
  assert.ok(pageOf("01") >= 3, "chapters carry their ordinal");
  // The contents entry names the page the chapter actually landed on — the
  // one format whose contents can afford real numbers.
  const contents = text[1]!;
  assert.ok(contents.includes("첫 장"), contents);
  assert.ok(contents.includes(String(pageOf("본문"))), "the number is the chapter's real page");
});

test("a memo stays a memo: no cover page, no contents, no ordinals", async () => {
  const { bytes, pages } = await renderPdf(parseMarkdown("## 하나\n\n본문"), {
    title: "t",
    created: CREATED,
  });
  assert.equal(pages, 1);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  assert.equal(text.includes("목차"), false);
});

test("an overlong paragraph word is wrapped within the page", async () => {
  const source = "x".repeat(400);
  const { bytes } = await renderPdf(parseMarkdown(source), { title: "Word", created: CREATED });
  assert.equal((await extractLines(bytes)).replace(/\s/g, ""), source);
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const content = await (await pdf.getPage(1)).getTextContent();
  for (const item of content.items) {
    if ("str" in item && item.str.trim()) {
      assert.ok(item.transform[4] + item.width < 540, "word stays inside the right margin");
    }
  }
});

test("oversized table rows paginate without losing cells or drawing below the page", async () => {
  const words = Array.from({ length: 600 }, (_, i) => `value${String(i).padStart(3, "0")}`);
  const source = "| Key | Description |\n| --- | --- |\n| A | " + words.join(" ") + " |\n| B | LAST |";
  const { bytes, pages } = await renderPdf(parseMarkdown(source), { title: "Table", created: CREATED });
  assert.ok(pages > 1);
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  let text = "";
  for (let n = 1; n <= pages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const items = content.items.filter((item) => "str" in item);
    assert.ok(items.some((item) => item.str === "Description"), "each table page repeats its header");
    for (const item of items) {
      if (item.str.trim()) {
        assert.ok(item.transform[5] > 20 && item.transform[5] < 800, "text stays within the page");
        text += item.str + " ";
      }
    }
  }
  for (const word of [...words, "LAST"]) assert.ok(text.includes(word), word);
});

test("a table header larger than a page is preserved without endless repetition", async () => {
  const heading = "heading ".repeat(800) + "HEADER_END";
  const { bytes, pages } = await renderPdf(parseMarkdown(`| ${heading} |\n| --- |\n| BODY_END |`), {
    title: "Tall header", created: CREATED,
  });
  const text = await extractLines(bytes);
  assert.ok(pages > 1 && pages < 10);
  assert.equal(text.match(/heading/g)?.length, 800);
  assert.ok(text.includes("HEADER_END") && text.includes("BODY_END"));
});

test("multi-page contents keep every heading and point to the shifted body pages", async () => {
  const titles = Array.from({ length: 50 }, (_, i) => `Topic${String(i).padStart(2, "0")} ` + "extended heading ".repeat(6) + `END${i}`);
  const source = "# Report\n\nSubtitle\n\n" + titles.map((title, i) => `## ${title}\n\nBODY${i}`).join("\n\n");
  const { bytes } = await renderPdf(parseMarkdown(source), { title: "Contents", created: CREATED });
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const firstBody = text.findIndex((page) => page.includes("BODY0"));
  assert.ok(firstBody > 2, "contents need multiple pages");
  const contents = text.slice(1, firstBody).join(" ").replace(/\b\d+\b/g, "").replace(/\s+/g, " ");
  for (const [i, title] of titles.entries()) {
    assert.ok(contents.includes(title.trim()), `complete title ${i}`);
    const page = text.findIndex((p) => p.includes(`BODY${i}`)) + 1;
    assert.ok(page > firstBody);
  }
  // Each number is aligned with the first line of its entry.
  let checked = 0;
  for (let page = 2; page <= firstBody; page += 1) {
    const items = (await (await pdf.getPage(page)).getTextContent()).items.filter((item) => "str" in item);
    for (const item of items) {
      const title = /Topic\d{2}/.exec(item.str)?.[0];
      if (!title) continue;
      const expected = text.slice(firstBody).findIndex((body) => body.includes(title)) + firstBody + 1;
      assert.ok(items.some((number) => number.str === String(expected) && number.transform[4] > 480 &&
        Math.abs(number.transform[5] - item.transform[5]) < 0.1), title);
      checked += 1;
    }
  }
  assert.equal(checked, titles.length);
});
