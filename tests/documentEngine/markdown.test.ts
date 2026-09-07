/**
 * The parser every renderer is downstream of. A mistake here appears in all
 * four formats at once and looks like four separate bugs.
 */

import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  escapeInline,
  escapeLineStart,
  opensBlock,
  parseInline,
  parseMarkdown,
  plainTextOf,
  renderRuns,
  withoutDirectives,
  type Block,
  type Run,
} from "@/infrastructure/documents/engine/markdown";

function blocks(source: string): Block[] {
  return parseMarkdown(source).blocks;
}

test("headings carry their level, and the first h1 becomes the title", () => {
  const document = parseMarkdown("# 보고서\n\n## 배경\n\n본문");
  assert.equal(document.title, "보고서");
  assert.deepEqual(
    document.blocks.map((block) => block.kind),
    ["heading", "heading", "paragraph"],
  );
  assert.equal(document.blocks[1]?.kind === "heading" ? document.blocks[1].level : 0, 2);
});

test("lines with no blank between them are one paragraph, as Markdown says", () => {
  const parsed = blocks("first line\nsecond line\n\nnew paragraph");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.kind === "paragraph" ? plainTextOf(parsed[0].runs) : "", "first line second line");
});

test("emphasis nests, and adjacent runs of one style are one run", () => {
  const runs = parseInline("plain **bold and *both* more** tail");
  assert.deepEqual(runs, [
    { text: "plain " },
    { text: "bold and ", bold: true },
    { text: "both", bold: true, italic: true },
    { text: " more", bold: true },
    { text: " tail" },
  ]);
});

test("a code span is literal, so markers inside it are characters", () => {
  assert.deepEqual(parseInline("run `a * b ** c` now"), [
    { text: "run " },
    { text: "a * b ** c", code: true },
    { text: " now" },
  ]);
});

test("an underscore inside a word is not emphasis", () => {
  // The regression this exists for: `snake_case_name` parsed as emphasis loses
  // its underscores and silently becomes a different identifier.
  assert.deepEqual(parseInline("call snake_case_name here"), [{ text: "call snake_case_name here" }]);
  assert.deepEqual(parseInline("_really_ emphasised"), [
    { text: "really", italic: true },
    { text: " emphasised" },
  ]);
});

test("links keep their target on every run they cover", () => {
  assert.deepEqual(parseInline("see [the **spec**](https://example.com/s)"), [
    { text: "see " },
    { text: "the ", href: "https://example.com/s" },
    { text: "spec", bold: true, href: "https://example.com/s" },
  ]);
  // An empty label is the URL: a link with no visible text is not a link.
  assert.deepEqual(parseInline("[](https://example.com)"), [
    { text: "https://example.com", href: "https://example.com" },
  ]);
});

test("a backslash escapes the punctuation Markdown gives meaning to", () => {
  assert.deepEqual(parseInline("2 \\* 3 \\*\\* 4"), [{ text: "2 * 3 ** 4" }]);
});

test("a fenced block keeps its lines and its language", () => {
  const parsed = blocks("```ts\nconst a = 1;\n\n  indented\n```\nafter");
  assert.deepEqual(parsed[0], { kind: "code", text: "const a = 1;\n\n  indented", language: "ts" });
  assert.equal(parsed[1]?.kind, "paragraph");
});

test("an unclosed fence takes the rest of the document, which is what it says", () => {
  const parsed = blocks("text\n\n```\nnever closed\nstill code");
  assert.deepEqual(parsed[1], { kind: "code", text: "never closed\nstill code" });
});

test("closing code fences contain only a matching marker and optional whitespace", () => {
  const source = "```txt\n```not a close\n    ```\ncontent\n````\nafter";
  assert.deepEqual(blocks(source), [
    { kind: "code", language: "txt", text: "```not a close\n    ```\ncontent" },
    { kind: "paragraph", runs: [{ text: "after" }] },
  ]);
  assert.deepEqual(blocks("~~~~\n~~~\n```\nbody\n  ~~~~~ \t"), [
    { kind: "code", text: "~~~\n```\nbody" },
  ]);
});

test("bullets and numbers are separate lists, and indentation is depth", () => {
  const parsed = blocks("- one\n  - nested\n- two\n\n1. first\n2. second");
  assert.deepEqual(parsed[0], {
    kind: "list",
    ordered: false,
    items: [
      { runs: [{ text: "one" }], depth: 0 },
      { runs: [{ text: "nested" }], depth: 1 },
      { runs: [{ text: "two" }], depth: 0 },
    ],
  });
  assert.equal(parsed[1]?.kind === "list" ? parsed[1].ordered : false, true);
});

test("a bullet list touching a numbered one does not merge into it", () => {
  // Merging would renumber one of them out of existence.
  const parsed = blocks("- bullet\n1. number");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.kind === "list" ? parsed[0].ordered : true, false);
  assert.equal(parsed[1]?.kind === "list" ? parsed[1].ordered : false, true);
});

test("a table needs its divider, and its cells are parsed as inline", () => {
  const parsed = blocks("| 이름 | 값 |\n|---|---:|\n| **a** | 1 |\n| b | 2 |");
  assert.equal(parsed[0]?.kind, "table");
  if (parsed[0]?.kind !== "table") {
    return;
  }
  assert.deepEqual(parsed[0].header.map(plainTextOf), ["이름", "값"]);
  assert.equal(parsed[0].rows.length, 2);
  assert.deepEqual(parsed[0].rows[0]?.[0], [{ text: "a", bold: true }]);
});

test("the divider's colons decide how each column is set", () => {
  const parsed = blocks("| a | b | c | d |\n|---|:---|:---:|---:|\n| 1 | 2 | 3 | 4 |");
  assert.deepEqual(
    parsed[0]?.kind === "table" ? parsed[0].align : [],
    ["left", "left", "center", "right"],
  );
});

test("a divider with no colons leaves every column flush left", () => {
  // Which is what these tables have always rendered as, so nothing written
  // before alignment existed moves.
  const parsed = blocks("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(parsed[0]?.kind === "table" ? parsed[0].align : [], ["left", "left"]);
});

test("a pipe row with no divider under it is a paragraph, not a table", () => {
  const parsed = blocks("a | b | c");
  assert.equal(parsed[0]?.kind, "paragraph");
});

test("table headers and delimiter rows must declare the same number of columns", () => {
  for (const source of ["| a | b |\n---", "| a | b |\n| --- |", "| a |\n| --- | --- |"] ) {
    assert.ok(blocks(source).every((block) => block.kind !== "table"));
  }
});

test("an escaped pipe stays inside its cell", () => {
  const parsed = blocks("| expr | note |\n|---|---|\n| a \\| b | or |");
  assert.equal(parsed[0]?.kind === "table" ? plainTextOf(parsed[0].rows[0]?.[0] ?? []) : "", "a | b");
});

test("consecutive quote lines are one quote", () => {
  const parsed = blocks("> first\n> second\n\nafter");
  assert.deepEqual(parsed[0], { kind: "quote", runs: [{ text: "first second" }] });
});

test("a rule is a rule, and a dash with text after it is a list item", () => {
  assert.deepEqual(blocks("---")[0], { kind: "rule" });
  assert.equal(blocks("- item")[0]?.kind, "list");
});

test("syntax this does not support survives as the characters that were written", () => {
  // Refusing to produce a document over one line of it would be a much worse
  // outcome than an unrendered `<div>` a reader can see.
  const parsed = blocks("<div>raw</div>\n\n[^1]: a footnote");
  assert.equal(plainTextOf(parsed[0]?.kind === "paragraph" ? parsed[0].runs : []), "<div>raw</div>");
  assert.equal(plainTextOf(parsed[1]?.kind === "paragraph" ? parsed[1].runs : []), "[^1]: a footnote");
});

test("an image becomes a link to the picture, labelled with its alt text", () => {
  // Nothing here embeds pictures. Dropping it would lose both the description
  // and the address; a literal `![alt](url)` in a rendered document is noise.
  assert.deepEqual(parseInline("see ![도표 1](https://example.com/chart.png)"), [
    { text: "see " },
    { text: "도표 1", href: "https://example.com/chart.png" },
  ]);
  assert.deepEqual(parseInline("![](x.png)"), [{ text: "image", href: "x.png" }]);
});

test("an empty document has no blocks and no title", () => {
  assert.deepEqual(parseMarkdown("   \n\n  "), { blocks: [] });
});

test("a ::: fence is a directive holding the blocks inside it", () => {
  const parsed = blocks(":::cards\n### A\n\n하나\n:::\n\n뒤 문단");
  assert.equal(parsed[0]?.kind, "directive");
  assert.ok(parsed[0]?.kind === "directive" && parsed[0].name === "cards");
  assert.ok(parsed[0]?.kind === "directive" && parsed[0].blocks[0]?.kind === "heading");
  assert.equal(parsed[1]?.kind, "paragraph");
});

test("an unclosed directive takes the rest of the document, as an unclosed fence does", () => {
  const parsed = blocks(":::metrics\n- 99% a\n- 43% b");
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0]?.kind === "directive" && parsed[0].blocks[0]?.kind === "list");
});

test("a directive fence does not glue onto the paragraph above it", () => {
  const parsed = blocks("문단\n:::quote\n> 인용\n:::");
  assert.equal(parsed[0]?.kind, "paragraph");
  assert.equal(parsed[1]?.kind, "directive");
});

test("a lone ::: with no name is text, not a directive", () => {
  assert.equal(blocks(":::")[0]?.kind, "paragraph");
});

test("withoutDirectives splices contents where the directive stood", () => {
  const document = parseMarkdown("앞\n\n:::cards\n### A\n:::\n\n뒤");
  const flat = withoutDirectives(document);
  assert.deepEqual(
    flat.blocks.map((block) => block.kind),
    ["paragraph", "heading", "paragraph"],
  );
});

test("directive nesting stops recursing at a sane depth", () => {
  // A hundred thousand unclosed opens must be a document, not a stack.
  const hostile = Array.from({ length: 2000 }, () => ":::a").join("\n");
  const parsed = parseMarkdown(hostile);
  assert.ok(parsed.blocks.length > 0, "it parses rather than overflowing");
});

/**
 * The dialect written and read back.
 *
 * These are the specification for the serializer: a reader that recovers a
 * document's shape has to be able to *say* it, and every string below is a way
 * for a naive writer to say something the parser then reads as something else.
 * A failure here is invisible downstream — the Markdown looks fine and means
 * something the document never said.
 */

/** Text → Markdown → text. What a paragraph of it must survive. */
function throughParagraph(text: string): string {
  const written = escapeLineStart(escapeInline(text));
  const [block] = parseMarkdown(written).blocks;
  assert.equal(block?.kind, "paragraph", `\`${written}\` did not parse as a paragraph`);
  return block?.kind === "paragraph" ? plainTextOf(block.runs) : "";
}

test("any text can be written as a paragraph and read back as itself", () => {
  for (const text of [
    "a|b",
    "# not a heading",
    "---",
    "***",
    "```",
    "~~~",
    ":::cards",
    ":::",
    "|---|",
    "| a | b |",
    "snake_case_name",
    "**not bold",
    "a*b*c",
    "1. not a list",
    "1) not a list",
    "- not a list",
    "+ not a list",
    "> not a quote",
    "[not](a link",
    "text with ] bracket",
    "[label](https://example.com)",
    "![alt](x.png)",
    "back\\slash",
    "a `tick` here",
    "C:\\Users\\bruce",
    "100% — 50% = 50%",
    "제목1 · 개요 2",
  ]) {
    assert.equal(throughParagraph(text), text, `round trip failed for: ${text}`);
  }
});

test("opensBlock knows every line the parser would take for a block", () => {
  for (const line of ["# h", "---", "```ts", ":::cards", ":::", "> q", "- i", "1. i", "|---|---|"]) {
    assert.ok(opensBlock(line), `${line} opens a block`);
  }
  for (const line of ["plain", "a - b", "1.no space", "#nospace", "a | b"]) {
    assert.ok(!opensBlock(line), `${line} does not open a block`);
  }
});

test("styled runs come back styled", () => {
  const round = (runs: Run[]): Run[] => parseInline(renderRuns(runs));
  assert.deepEqual(round([{ text: "bold", bold: true }]), [{ text: "bold", bold: true }]);
  assert.deepEqual(round([{ text: "it", italic: true }]), [{ text: "it", italic: true }]);
  assert.deepEqual(round([{ text: "both", bold: true, italic: true }]), [
    { text: "both", bold: true, italic: true },
  ]);
  assert.deepEqual(round([{ text: "a|b", code: true }]), [{ text: "a|b", code: true }]);
  assert.deepEqual(round([{ text: "label", href: "https://x/a(b)" }]), [
    { text: "label", href: "https://x/a(b)" },
  ]);
});

test("padding around emphasis stays outside the delimiters", () => {
  // `**  bold  **` is not bold — the parser requires a non-space beside each
  // delimiter — so a writer that wraps the padding loses the emphasis and says
  // nothing about it.
  assert.equal(renderRuns([{ text: "  bold  ", bold: true }]), "  **bold**  ");
  assert.deepEqual(parseInline(renderRuns([{ text: " x ", italic: true }])), [
    { text: " " },
    { text: "x", italic: true },
    { text: " " },
  ]);
  // Nothing but whitespace cannot carry emphasis at all, so it gets none.
  assert.equal(renderRuns([{ text: "   ", bold: true }]), "   ");
});

test("a code span holding backticks gets a longer fence", () => {
  assert.equal(renderRuns([{ text: "a ` b", code: true }]), "``a ` b``");
  assert.deepEqual(parseInline(renderRuns([{ text: "a ` b", code: true }])), [
    { text: "a ` b", code: true },
  ]);
});

test("a link label that holds a bracket does not end early", () => {
  const runs = parseInline(renderRuns([{ text: "see [1]", href: "https://x" }]));
  assert.deepEqual(runs, [{ text: "see [1]", href: "https://x" }]);
});
