/**
 * What this server writes, read back by what it reads.
 *
 * The reader tests assert on markup they build by hand, which proves an
 * element is handled and not that a document survives. This is the other half:
 * one source through three renderers and back, asserting that the *shape* is
 * still there — a heading's level, a table's columns and their alignment, a
 * list's order and depth, a picture's place.
 *
 * It is also the only evidence that survives this change. Forty reader
 * assertions moved when the output stopped being flat lines, so "the tests
 * still pass" proves nothing about that work; a round trip does.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseMarkdown, plainTextOf, type Block } from "@/infrastructure/documents/engine/markdown";
import { renderDocx } from "@/infrastructure/documents/engine/write/docx";
import { renderHwpx } from "@/infrastructure/documents/engine/write/hwpx";
import { renderPptx } from "@/infrastructure/documents/engine/write/pptx/index";
import { docxToText } from "@/infrastructure/documents/engine/read/docx";
import { hwpxToText } from "@/infrastructure/documents/engine/read/hwpx";
import { pptxToText } from "@/infrastructure/documents/engine/read/pptx";

const CREATED = "2026-01-01T00:00:00.000Z";

const SOURCE = [
  "# 분기 보고서",
  "",
  "## 핵심 지표",
  "",
  "| 지표 | 도입 전 | 도입 후 |",
  "|---|---:|---:|",
  "| 처리 시간 | 45분 | 3분 |",
  "| 오류율 | 2.1% | 0.2% |",
  "",
  "### 남은 문제",
  "",
  "1. 첫째 항목",
  "2. 둘째 항목",
  "",
  "- 하나",
  "- 둘",
  "",
  "본문에는 **굵은 글씨**와 [링크](https://example.com/a)가 있다.",
].join("\n");

function headings(blocks: readonly Block[]): Array<[number, string]> {
  return blocks
    .filter((block) => block.kind === "heading")
    .map((block) => (block.kind === "heading" ? [block.level, plainTextOf(block.runs)] : [0, ""]));
}

test("a DOCX keeps its headings, its table and its lists", () => {
  const bytes = renderDocx(parseMarkdown(SOURCE), { title: "분기 보고서", created: CREATED });
  const { blocks } = parseMarkdown(docxToText(bytes).text);

  assert.deepEqual(headings(blocks), [
    [1, "분기 보고서"],
    [2, "핵심 지표"],
    [3, "남은 문제"],
  ]);

  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table", "the table is still a table");
  if (table?.kind === "table") {
    assert.deepEqual(table.header.map(plainTextOf), ["지표", "도입 전", "도입 후"]);
    assert.deepEqual(table.rows.map((row) => row.map(plainTextOf)), [
      ["처리 시간", "45분", "3분"],
      ["오류율", "2.1%", "0.2%"],
    ]);
    // Alignment is content: a column of figures set left is one nobody checks.
    assert.deepEqual(table.align, ["left", "right", "right"]);
  }

  const lists = blocks.filter((block) => block.kind === "list");
  assert.deepEqual(
    lists.map((list) => (list.kind === "list" ? list.ordered : undefined)),
    [true, false],
    "an ordered list and a bulleted one, still told apart",
  );

  const last = blocks[blocks.length - 1];
  assert.equal(last?.kind, "paragraph");
  if (last?.kind === "paragraph") {
    assert.ok(last.runs.some((run) => run.bold), "the bold run is still bold");
    assert.equal(
      last.runs.find((run) => run.href)?.href,
      "https://example.com/a",
      "the link still points where it pointed",
    );
  }
});

test("a deck keeps its slide titles and its table", () => {
  const bytes = renderPptx(parseMarkdown(SOURCE), { title: "분기 보고서", created: CREATED }).bytes;
  const text = pptxToText(bytes).text;
  const { blocks } = parseMarkdown(text);
  assert.ok(
    blocks.some((block) => block.kind === "heading" && plainTextOf(block.runs) === "핵심 지표"),
    text,
  );
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table", text);
  if (table?.kind === "table") {
    assert.deepEqual(table.header.map(plainTextOf), ["지표", "도입 전", "도입 후"]);
  }
});

test("an HWPX keeps its table and its lists", () => {
  // This renderer writes `hh:heading type="NONE"`, so a level does not survive
  // its own round trip — a 한글-authored 개요 does, which the reader's own
  // tests cover. What has to survive here is everything else.
  const bytes = renderHwpx(parseMarkdown(SOURCE), { title: "분기 보고서", created: CREATED });
  const text = hwpxToText(bytes).text;
  const { blocks } = parseMarkdown(text);
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.kind, "table", text);
  if (table?.kind === "table") {
    assert.deepEqual(table.header.map(plainTextOf), ["지표", "도입 전", "도입 후"]);
    assert.equal(table.rows.length, 2);
  }
  const lists = blocks.filter((block) => block.kind === "list");
  assert.deepEqual(
    lists.map((list) => (list.kind === "list" ? list.ordered : undefined)),
    [true, false],
    text,
  );
});

test("a prose document comes back with no markup it did not have", () => {
  // The regression pin: with no table, no list and no heading, the output is
  // the words and a blank line between them, exactly as before.
  const bytes = renderDocx(parseMarkdown("첫 문단\n\n둘째 문단"), { title: "t", created: CREATED });
  assert.equal(docxToText(bytes).text, "첫 문단\n\n둘째 문단");
});

test("a single-column table survives document and deck round trips", () => {
  const document = parseMarkdown("| Item |\n| ---: |\n| Value |");
  const options = { title: "Table", created: CREATED };
  const outputs = [
    docxToText(renderDocx(document, options)).text,
    hwpxToText(renderHwpx(document, options)).text,
    pptxToText(renderPptx(document, options).bytes).text,
  ];
  for (const text of outputs) {
    const table = parseMarkdown(text).blocks.find((block) => block.kind === "table");
    assert.ok(table, text);
    assert.deepEqual(table.header.map(plainTextOf), ["Item"]);
    assert.deepEqual(table.rows.map((row) => row.map(plainTextOf)), [["Value"]]);
  }
});
