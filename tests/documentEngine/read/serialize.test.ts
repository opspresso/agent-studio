/**
 * Blocks in, Markdown out — and read back, because the only claim worth making
 * about this file is that what it writes says what the document said.
 *
 * Every case here is a way for a table to stop being a table: a divider that
 * never got written, a row cut in half, a cell whose pipe ended it early, a
 * merge that shifted the columns after it.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseMarkdown, plainTextOf } from "@/infrastructure/documents/engine/markdown";
import type { ReadBlock, ReadCell, ReadTable } from "@/infrastructure/documents/engine/read/blocks";
import { blocksToMarkdown } from "@/infrastructure/documents/engine/read/serialize";

const write = (blocks: ReadBlock[], max = 90_000) => blocksToMarkdown(blocks, max);
const cell = (text: string, span?: Partial<ReadCell>): ReadCell => ({ runs: [{ text }], ...span });

function table(rows: ReadCell[][], extra: Partial<ReadTable> = {}): ReadTable {
  const columns = Math.max(
    ...rows.map((row) => row.reduce((total, one) => total + (one.colspan ?? 1), 0)),
  );
  return {
    kind: "table",
    rows: rows.map((cells) => ({ cells })),
    columns,
    align: Array.from({ length: columns }, () => "left" as const),
    totalRows: rows.length,
    merged: false,
    ...extra,
  };
}

test("blocks are separated by a blank line, because that is what Markdown means", () => {
  // Two paragraphs on adjacent lines are one paragraph when the text is read
  // back — the blank is the difference between saying two things and one.
  const { text } = write([
    { kind: "paragraph", runs: [{ text: "first" }] },
    { kind: "paragraph", runs: [{ text: "second" }] },
  ]);
  assert.equal(text, "first\n\nsecond");
  assert.equal(parseMarkdown(text).blocks.length, 2);
});

test("a table is a table when it is read back", () => {
  const { text } = write([
    table([[cell("지표"), cell("값")], [cell("가용성"), cell("99.99%")]], {
      align: ["left", "right"],
      rows: [
        { cells: [cell("지표"), cell("값")], header: true },
        { cells: [cell("가용성"), cell("99.99%")] },
      ],
    }),
  ]);
  assert.equal(text, "| 지표 | 값 |\n| --- | --: |\n| 가용성 | 99.99% |");
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "table");
  if (block?.kind === "table") {
    assert.deepEqual(block.align, ["left", "right"]);
    assert.deepEqual(block.header.map(plainTextOf), ["지표", "값"]);
    assert.deepEqual(block.rows.map((row) => row.map(plainTextOf)), [["가용성", "99.99%"]]);
  }
});

test("a pipe inside a cell does not end it", () => {
  const { text } = write([table([[cell("a|b"), cell("c")], [cell("d"), cell("e")]])]);
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "table");
  if (block?.kind === "table") {
    assert.deepEqual(block.header.map(plainTextOf), ["a|b", "c"]);
  }
});

test("a spanning cell keeps its column and leaves the rest empty", () => {
  // Repeating the value into every covered column would invent data; leaving
  // the gap is what keeps the columns after it where they belong.
  const { text } = write([
    table([[cell("2026년", { colspan: 2 }), cell("비고")], [cell("a"), cell("b"), cell("c")]], {
      merged: true,
    }),
  ]);
  assert.equal(text.split("\n")[0], "| 2026년 |  | 비고 |");
  const [block] = parseMarkdown(text).blocks;
  assert.ok(block?.kind === "table", text);
  assert.deepEqual(block.rows.map((row) => row.map(plainTextOf)), [["a", "b", "c"]]);
});

test("a cell that spans rows leaves the row below it empty in that column", () => {
  const { text } = write([
    table([[cell("묶음", { rowspan: 2 }), cell("a")], [cell("b")]], { merged: true }),
  ]);
  assert.deepEqual(text.split("\n"), ["| 묶음 | a |", "| --- | --- |", "|  | b |"]);
});

test("a one-column table retains its structure and alignment", () => {
  const written = write([table([[cell("only")], [cell("rows")]], { align: ["right"] })]);
  assert.equal(written.text, "| only |\n| --: |\n| rows |");
  const [block] = parseMarkdown(written.text).blocks;
  assert.equal(block?.kind, "table");
  if (block?.kind === "table") {
    assert.deepEqual(block.align, ["right"]);
    assert.deepEqual(block.header.map(plainTextOf), ["only"]);
    assert.deepEqual(block.rows.map((row) => row.map(plainTextOf)), [["rows"]]);
  }
  const partial = write([table([[cell("only")], [cell("rows")]])], 18);
  assert.equal(partial.complete, false);
  assert.equal(parseMarkdown(partial.text).blocks[0]?.kind, "table");
});

test("the header is the row the document marked, not the first one", () => {
  const { text } = write([
    table([], {
      columns: 2,
      rows: [
        { cells: [cell("메모"), cell("")] },
        { cells: [cell("항목"), cell("값")], header: true },
      ],
      align: ["left", "left"],
      totalRows: 2,
    }),
  ]);
  assert.equal(text.split("\n")[0], "| 항목 | 값 |");
});

test("a list keeps its order and its depth", () => {
  const { text } = write([
    {
      kind: "list",
      ordered: true,
      items: [
        { runs: [{ text: "첫째" }], depth: 0 },
        { runs: [{ text: "하위" }], depth: 1 },
        { runs: [{ text: "둘째" }], depth: 0 },
      ],
    },
  ]);
  assert.equal(text, "1. 첫째\n  1. 하위\n2. 둘째");
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "list");
  if (block?.kind === "list") {
    assert.equal(block.ordered, true);
    assert.deepEqual(block.items.map((item) => item.depth), [0, 1, 0]);
  }
});

test("a paragraph that looks like a heading is a paragraph when it comes back", () => {
  const { text } = write([{ kind: "paragraph", runs: [{ text: "# 1972년 성적" }] }]);
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "paragraph");
  if (block?.kind === "paragraph") {
    assert.equal(plainTextOf(block.runs), "# 1972년 성적");
  }
});

test("a code block holding a fence gets a longer one", () => {
  const { text } = write([{ kind: "code", language: "md", text: "```\nnested\n```" }]);
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "code");
  if (block?.kind === "code") {
    assert.equal(block.text, "```\nnested\n```");
    assert.equal(block.language, "md");
  }
});

test("an image says where the picture is and what it was called", () => {
  const { text } = write([
    { kind: "image", alt: "조직도", target: "word/media/image1.png", bytes: 41_208 },
  ]);
  assert.equal(text, "![조직도](word/media/image1.png)");
});

test("a break names its unit, which a bare title would not", () => {
  const { text } = write([
    { kind: "break", unit: "slide", index: 1, name: "Overview" },
    { kind: "paragraph", runs: [{ text: "본문" }] },
    { kind: "break", unit: "sheet", index: 2 },
  ]);
  assert.equal(text, "## Slide 1: Overview\n\n본문\n\n## Sheet 2");
});

test("the budget stops on a block boundary and says it stopped", () => {
  const blocks: ReadBlock[] = [
    { kind: "paragraph", runs: [{ text: "a".repeat(30) }] },
    { kind: "paragraph", runs: [{ text: "b".repeat(30) }] },
  ];
  const written = write(blocks, 40);
  assert.equal(written.text, "a".repeat(30));
  assert.equal(written.blocks, 1);
  assert.equal(written.complete, false);
});

test("a table is cut on a row boundary, never before its divider", () => {
  // A header with no divider under it is a paragraph full of pipes, and a row
  // cut in half is a row whose columns no longer line up.
  const rows = Array.from({ length: 40 }, (_, index) => [cell(`r${index}`), cell("value")]);
  const written = write([table(rows)], 120);
  assert.equal(written.complete, false);
  assert.ok(written.text.split("\n")[1]?.startsWith("| ---"), "the divider survives the cut");
  const [block] = parseMarkdown(written.text).blocks;
  assert.equal(block?.kind, "table", "what was written is still a table");
  assert.ok(written.rows !== undefined && written.rows.kept < written.rows.total);
});

test("a table too small to open at all writes nothing rather than half a table", () => {
  const written = write([table([[cell("a"), cell("b")], [cell("c"), cell("d")]])], 5);
  assert.equal(written.text, "");
  assert.equal(written.complete, false);
});

test("an alt text that holds a bracket does not become a link to somewhere else", () => {
  // Unescaped, an alt of `a](x) b` writes `![a](x) b](m.png)` — which reads
  // back as a link to `x` followed by stray characters. The caption is gone and
  // an address nobody wrote has appeared.
  for (const alt of ["그림 [1] 조직도", "a](x) b", "**not bold", "a`b"]) {
    const { text } = write([{ kind: "image", alt, target: "word/media/a.png" }]);
    const [block] = parseMarkdown(text).blocks;
    assert.equal(block?.kind, "paragraph", text);
    if (block?.kind === "paragraph") {
      assert.deepEqual(block.runs, [{ text: alt, href: "word/media/a.png" }], text);
    }
  }
});

test("a target that holds a bracket or a space is still the target", () => {
  const { text } = write([{ kind: "image", alt: "x", target: "media/a (1).png" }]);
  const [block] = parseMarkdown(text).blocks;
  assert.ok(block?.kind === "paragraph", text);
  assert.equal(block.runs[0]?.href, "media/a (1).png", text);
});

test("a break's name is one line, because a heading is", () => {
  // The name is the document's own string and may hold anything. A newline
  // would put the rest of it in a paragraph between the boundary and what
  // follows.
  const { text } = write([{ kind: "break", unit: "sheet", index: 1, name: "1분기\n실적" }]);
  assert.equal(text, "## 1분기 실적");
  assert.equal(parseMarkdown(text).blocks.length, 1);
});

test("a code block's language is one word and no backticks", () => {
  // `FENCE` captures `[^`\s]*`, and a backtick in the language closes the fence
  // it was supposed to open.
  const { text } = write([{ kind: "code", language: "```ts extra", text: "x" }]);
  const [block] = parseMarkdown(text).blocks;
  assert.equal(block?.kind, "code");
  if (block?.kind === "code") {
    assert.equal(block.language, "ts");
    assert.equal(block.text, "x");
  }
});
