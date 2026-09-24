/**
 * HWPX generation, checked by reading it back.
 *
 * The round trip is what it is elsewhere. What is different here is how much
 * these tests are *not* able to say: HWPX has one reader that matters, and
 * nothing in this file knows whether 한글 opens the result. So the assertions
 * cover the parts a wrong file gets wrong in a way that is checkable — the
 * package layout, the id references resolving against the header, a cell
 * holding a paragraph — and the rest is a manual step the README names.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { hwpxToText } from "@/infrastructure/documents/engine/read/hwpx";
import { parseMarkdown } from "@/infrastructure/documents/engine/markdown";
import { detect } from "@/infrastructure/documents/engine/detect";
import { listEntries, readEntries } from "@/infrastructure/documents/engine/zip";
import { renderHwpx } from "@/infrastructure/documents/engine/write/hwpx";

const OPTIONS = { title: "test", created: "2026-08-05T00:00:00Z" };

function build(markdown: string): Uint8Array {
  return renderHwpx(parseMarkdown(markdown), OPTIONS);
}

function roundTrip(markdown: string): string {
  return hwpxToText(build(markdown)).text;
}

function partOf(bytes: Uint8Array, name: string): string {
  const part = readEntries(bytes, [name]).get(name);
  assert.ok(part, `expected the archive to hold ${name}`);
  return new TextDecoder().decode(part);
}

test("the package has the parts OWPML requires, with mimetype first and stored", () => {
  const bytes = build("# 제목\n\n본문");
  const names = listEntries(bytes).map((entry) => entry.name);
  assert.equal(names[0], "mimetype");
  for (const required of [
    "version.xml",
    "settings.xml",
    "META-INF/container.xml",
    "META-INF/manifest.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
  ]) {
    assert.ok(names.includes(required), `the package should hold ${required}`);
  }
  // Stored, so the type is readable at a fixed offset without inflating.
  assert.equal(
    Buffer.from(bytes.subarray(30, 38)).toString("latin1"),
    "mimetype",
    "mimetype must be the first entry",
  );
  assert.equal(partOf(bytes, "mimetype"), "application/hwp+zip");
});

test("what this writes, this server recognises as HWPX", () => {
  assert.equal(detect(build("본문"), "", undefined).format, "hwpx");
});

test("headings and paragraphs come back as their text", () => {
  // This renderer writes `hh:heading type="NONE"` and sets its headings apart
  // by size and weight, so the reader recovers the weight and not a level.
  // A 한글-authored document with a real 개요 comes back as a heading.
  assert.equal(
    roundTrip("# 분기 보고서\n\n첫 문단\n\n둘째 문단"),
    "**분기 보고서**\n\n첫 문단\n\n둘째 문단",
  );
});

test("lists come back as the markers they were written with", () => {
  assert.equal(roundTrip("- 하나\n- 둘"), "- 하나\n- 둘");
  assert.equal(roundTrip("1. 첫째\n2. 둘째"), "1. 첫째\n2. 둘째");
});

test("a table round-trips, and every cell holds a paragraph", () => {
  const bytes = build("| 이름 | 값 |\n|---|---|\n| 가 | 1 |");
  assert.equal(hwpxToText(bytes).text, "| **이름** | **값** |\n| --- | --- |\n| 가 | 1 |");
  const section = partOf(bytes, "Contents/section0.xml");
  // A `hp:tc` with no paragraph inside is what makes 한글 refuse a file.
  assert.equal(/<hp:tc[^>]*>(?:(?!<hp:p[ >]).)*<\/hp:tc>/s.test(section), false);
  assert.match(section, /<hp:cellAddr colAddr="1" rowAddr="1"\/>/);
});

test("a formal profile carries its light table treatment into the HWPX header", () => {
  const bytes = renderHwpx(parseMarkdown("| 이름 | 값 |\n|---|---:|\n| 처리량 | 42 |"), {
    ...OPTIONS,
    profile: "formal",
  });
  const header = partOf(bytes, "Contents/header.xml");
  assert.ok(header.includes('faceColor="#EDF1F4"'));
  assert.ok(header.includes('textColor="#334E68"'));
});

test("body, headings and cover use role-based leading with native kerning", () => {
  const bytes = build("# 여러 줄 표지 제목\n\n부제\n\n## 여러 줄 본문 제목\n\n본문");
  const header = partOf(bytes, "Contents/header.xml");
  assert.ok(header.includes('useFontSpace="0" useKerning="1"'));
  for (const leading of [150, 120, 115, 140, 135]) {
    assert.ok(header.includes(`<hh:lineSpacing type="PERCENT" value="${leading}" unit="HWPUNIT"/>`));
  }
});

test("the HWPX cover carries the same short profile rule as the other page formats", () => {
  const bytes = build("# 표지 제목\n\n부제");
  const header = partOf(bytes, "Contents/header.xml");
  const section = partOf(bytes, "Contents/section0.xml");
  assert.ok(header.includes('width="1.0 mm" color="#17324D"'));
  assert.ok(header.includes('<hc:right value="43390" unit="HWPUNIT"/>'));
  assert.match(section, /<hp:p[^>]*paraPrIDRef="\d+"[^>]*><hp:run[^>]*><hp:secPr[\s\S]*?<hp:t><\/hp:t><\/hp:run>/);
});

test("every id a paragraph or run refers to exists in the header", () => {
  // The reference that does not resolve is the failure mode of this format:
  // nothing in the body says what a style is, only which numbered one it wants.
  const bytes = build(
    "# 제목\n\n**굵게** *기울임* `코드` [링크](https://example.com)\n\n> 인용\n\n- 목록\n\n" +
      "| 이름 | 값 |\n|:---:|---:|\n| a | 1 |\n| b | 2 |\n\n```\ncode\n```",
  );
  const header = partOf(bytes, "Contents/header.xml");
  const section = partOf(bytes, "Contents/section0.xml");
  const declared = (xml: string, pattern: RegExp): Set<string> =>
    new Set([...xml.matchAll(pattern)].map((match) => match[1]!));
  const charIds = declared(header, /<hh:charPr id="(\d+)"/g);
  const paraIds = declared(header, /<hh:paraPr id="(\d+)"/g);
  const fillIds = declared(header, /<hh:borderFill id="(\d+)"/g);
  for (const id of declared(section, /charPrIDRef="(\d+)"/g)) {
    assert.ok(charIds.has(id), `charPr ${id} is referenced but not declared`);
  }
  for (const id of declared(section, /paraPrIDRef="(\d+)"/g)) {
    assert.ok(paraIds.has(id), `paraPr ${id} is referenced but not declared`);
  }
  // Border fills are referenced from the header's own paragraph properties as
  // well as from the body's cells, so both sides are checked against the list.
  for (const id of declared(`${section}${header}`, /borderFillIDRef="(\d+)"/g)) {
    assert.ok(fillIds.has(id), `borderFill ${id} is referenced but not declared`);
  }
});

test("a column asked to be centred or set right says so in its paragraph properties", () => {
  const bytes = build("| a | n |\n|:---:|---:|\n| x | 42 |");
  const header = partOf(bytes, "Contents/header.xml");
  const section = partOf(bytes, "Contents/section0.xml");
  // The alignment lives in a `paraPr`, so the body only names an id — the test
  // has to follow the reference to see which one it got.
  const used = [...section.matchAll(/paraPrIDRef="(\d+)"/g)].map((match) => match[1]!);
  const alignmentOf = (id: string): string =>
    new RegExp(`<hh:paraPr id="${id}"[^>]*>\\s*<hh:align horizontal="([A-Z]+)"`).exec(header)?.[1] ??
    "";
  const alignments = new Set(used.map(alignmentOf));
  assert.ok(alignments.has("CENTER"), "the first column asked to be centred");
  assert.ok(alignments.has("RIGHT"), "the second asked to be set right");
});

test("a paragraph that wraps carries one lineseg per estimated line", () => {
  // 한글's checker flags a wrapped paragraph holding a single lineseg as
  // depending on non-standard reflow. The estimate only has to get the count
  // roughly right — the editor recalculates the geometry on open.
  const long = "가".repeat(120);
  const section = partOf(build(`${long}\n\n짧은 문단`), "Contents/section0.xml");
  const arrays = [...section.matchAll(/<hp:linesegarray>([\s\S]*?)<\/hp:linesegarray>/g)].map(
    (match) => (match[1]!.match(/<hp:lineseg /g) ?? []).length,
  );
  assert.ok((arrays[0] ?? 0) >= 2, `120 wide characters should wrap: got ${arrays[0]} lineseg(s)`);
  assert.equal(arrays[1], 1, "a short paragraph is one line");
  // Every lineseg after the first names where its line starts.
  assert.match(section, /<hp:lineseg textpos="[1-9]\d*"/);
});

test("line segments never start inside an emoji surrogate pair", () => {
  for (const text of ["a".repeat(79) + "😀b", "a".repeat(35) + "😀" + "a".repeat(5)]) {
    const section = partOf(build(text), "Contents/section0.xml");
    const array = /<hp:linesegarray>([\s\S]*?)<\/hp:linesegarray>/.exec(section)?.[1] ?? "";
    const starts = [...array.matchAll(/<hp:lineseg textpos="(\d+)"/g)].map((match) => Number(match[1]));
    assert.ok(starts.length > 1, "the paragraph should span multiple line segments");
    for (const start of starts) {
      const unit = text.charCodeAt(start);
      assert.ok(unit < 0xdc00 || unit > 0xdfff, `line starts inside a surrogate pair at ${start}`);
    }
  }
  const short = partOf(build("😀".repeat(30)), "Contents/section0.xml");
  const array = /<hp:linesegarray>([\s\S]*?)<\/hp:linesegarray>/.exec(short)?.[1] ?? "";
  assert.equal((array.match(/<hp:lineseg /g) ?? []).length, 1, "30 code points do not need a forced split");
});

test("the section properties are written exactly once", () => {
  // They ride inside the first run of the document. Twice is a second section
  // definition; never is a document with no page size.
  const section = partOf(build("# 제목\n\n본문\n\n또 본문"), "Contents/section0.xml");
  assert.equal(section.match(/<hp:secPr /g)?.length, 1);
});

test("a leading table keeps section properties and page breaks outside its cells", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const first = partOf(build(table), "Contents/section0.xml");
  assert.match(first, /<hs:sec[^>]*><hp:p[^>]*><hp:run[^>]*><hp:secPr /);
  assert.equal(first.match(/<hp:secPr /g)?.length, 1);
  const afterCover = partOf(build(`# Cover\n\n${table}`), "Contents/section0.xml");
  assert.ok(afterCover.indexOf('pageBreak="1"') < afterCover.indexOf("<hp:tbl "));
  assert.equal(afterCover.match(/pageBreak="1"/g)?.length, 1);
});

test("an empty document still carries its section", () => {
  const bytes = renderHwpx({ blocks: [] }, OPTIONS);
  const section = partOf(bytes, "Contents/section0.xml");
  assert.equal(section.match(/<hp:secPr /g)?.length, 1);
  assert.match(section, /<hp:p /);
});

test("a tab inside text becomes the element HWPX uses for one", () => {
  const section = partOf(build("before\tafter"), "Contents/section0.xml");
  assert.match(section, /<hp:tab /);
  assert.equal(section.includes("before\tafter"), false);
});

test("XML metacharacters in the text do not become markup", () => {
  assert.equal(roundTrip('a < b & c > d "quoted"'), 'a < b & c > d "quoted"');
});

test("the title lands in the package metadata, escaped", () => {
  const bytes = renderHwpx(parseMarkdown("본문"), { ...OPTIONS, title: "A & B <보고서>" });
  assert.match(partOf(bytes, "Contents/content.hpf"), /<opf:title>A &amp; B &lt;보고서&gt;<\/opf:title>/);
});

test("the file records what wrote it", () => {
  // OWPML keeps the name and the version apart, which is why this is the one
  // format that does not take the single producer string.
  const version = partOf(build("본문"), "version.xml");
  assert.match(version, /application="Agent Studio"/);
  assert.match(version, /appVersion="\d+\.\d+\.\d+"/);
});

test("the same input twice produces the same bytes", () => {
  assert.deepEqual(build("# same\n\ntext"), build("# same\n\ntext"));
});

test("a report gets a cover, a contents list and numbered chapters, each on its page", () => {
  const bytes = build("# 보고서\n\n부제 한 줄\n\n# 첫 장\n\n본문\n\n# 둘째 장\n\n## 절\n\n내용");
  const section = new TextDecoder().decode(
    readEntries(bytes, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  // The break rides the paragraph attribute 한글 itself writes; one break after
  // the cover, one after the contents, one before the second chapter.
  assert.equal(section.match(/pageBreak="1"/g)?.length, 3);
  const text = roundTrip("# 보고서\n\n부제 한 줄\n\n# 첫 장\n\n본문\n\n# 둘째 장\n\n## 절\n\n내용");
  assert.ok(text.includes("목차"), text);
  assert.ok(text.indexOf("목차") < text.indexOf("01"), "contents precede the first chapter");
  assert.ok(text.includes("**01**\n\n**첫 장**"), text);
  assert.ok(text.includes("**02**\n\n**둘째 장**"), text);
});

test("the cover styles resolve against the header, like every other id", () => {
  const bytes = build("# 표지\n\n부제");
  const section = new TextDecoder().decode(
    readEntries(bytes, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  const header = new TextDecoder().decode(
    readEntries(bytes, ["Contents/header.xml"]).get("Contents/header.xml")!,
  );
  for (const id of section.matchAll(/charPrIDRef="(\d+)"/g)) {
    assert.ok(header.includes(`<hh:charPr id="${id[1]}"`), `charPr ${id[1]} must be declared`);
  }
  for (const id of section.matchAll(/paraPrIDRef="(\d+)"/g)) {
    assert.ok(header.includes(`<hh:paraPr id="${id[1]}"`), `paraPr ${id[1]} must be declared`);
  }
});

test("a memo gets no contents list and no page breaks", () => {
  const bytes = build("# 메모\n\n한 줄\n\n## 하나\n\n내용");
  const section = new TextDecoder().decode(
    readEntries(bytes, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  // The cover still breaks to the body; nothing else does.
  assert.equal(section.match(/pageBreak="1"/g)?.length, 1);
  assert.equal(roundTrip("# 메모\n\n한 줄\n\n## 하나\n\n내용").includes("목차"), false);
});

test("a paragraph near the line's edge gets two linesegs, not one and a hope", () => {
  // 42 full-width characters fit the stated width but not the safety-reduced
  // one. One lineseg here is the shape 한글's checker calls non-standard: the
  // paragraph would wrap on screen while the file claims a single line.
  const nearEdge = "가".repeat(42);
  const bytes = build(`${nearEdge}`);
  const section = new TextDecoder().decode(
    readEntries(bytes, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  const paragraph = /<hp:p [^>]*>(?:(?!<\/hp:p>)[\s\S])*<\/hp:p>/.exec(section)![0];
  assert.ok(
    (paragraph.match(/<hp:lineseg /g)?.length ?? 0) >= 2,
    "the boundary case must err toward more linesegs",
  );
});

test("a cell's linesegs are estimated against its text area, margins taken out", () => {
  const bytes = build("| a | b |\n|---|---|\n| 짧다 | 이 셀의 문장은 셀 여백을 빼고 나면 한 줄에 들어가지 못할 만큼 길게 이어진다 |");
  const section = new TextDecoder().decode(
    readEntries(bytes, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  // The long cell must carry more than one lineseg once margins are honoured.
  const cells = section.match(/<hp:tc [\s\S]*?<\/hp:tc>/g)!;
  const long = cells.find((cell) => cell.includes("길게"))!;
  assert.ok((long.match(/<hp:lineseg /g)?.length ?? 0) >= 2, "the long cell wraps in the count too");
});

test("no paragraph over forty characters claims a single lineseg — rhwp's contract", () => {
  // The rule is rhwp's `LinesegTextRunReflow` check, verbatim: one lineseg,
  // no newline, more than forty characters — width never enters into it. A
  // 42-character Latin line fits one line in every honest metric and is
  // flagged anyway, so the writer breaks it at a word boundary instead.
  const latin = build("tools: await mcp.discover('agent-mcps') and more");
  const section = new TextDecoder().decode(
    readEntries(latin, ["Contents/section0.xml"]).get("Contents/section0.xml")!,
  );
  for (const paragraph of section.matchAll(/<hp:p [^>]*>((?:(?!<hp:p |<\/hp:p>)[\s\S])*?)<\/hp:p>/g)) {
    const segs = (paragraph[1]!.match(/<hp:lineseg /g) ?? []).length;
    const text = [...paragraph[1]!.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("");
    if ([...text].length > 40) {
      assert.ok(segs >= 2, `"${text.slice(0, 30)}…" carries ${segs} lineseg`);
    }
  }
});
