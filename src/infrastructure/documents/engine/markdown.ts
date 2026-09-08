/**
 * Markdown in, one document model, four report and presentation formats out.
 *
 * One parser and three renderers, rather than three writers each with its own
 * idea of what `**bold**` is. The shape in between is deliberately small — runs
 * of styled text inside a handful of block kinds — because it is the greatest
 * common denominator of DOCX, PDF and HWPX, and anything richer would be a
 * feature one renderer could honour and the others would silently drop.
 *
 * **Unsupported syntax is not an error.** Footnotes, raw HTML, nested
 * blockquotes: these come through as the literal characters the caller wrote.
 * The alternative is refusing to produce a document over a line of it, which
 * for a model writing a report is a much worse outcome than a stray `<div>` in
 * the output — and it is visible in the result rather than hidden in a diff.
 *
 * An image is the one exception, because dropping it loses two things a reader
 * wants. `![alt](url)` becomes a **link** carrying the alt text: nothing here
 * fetches or embeds pictures, so the honest rendering is a pointer to where the
 * picture is, labelled with what it was said to be.
 *
 * Paragraph continuation follows Markdown rather than the source: two lines
 * with no blank between them are one paragraph. That is what the format says,
 * and a renderer cannot recover a distinction the parser threw away — so the
 * tool description says it, and a caller who wants two lines leaves a blank
 * line between them.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export interface ListItem {
  runs: Run[];
  /** Nesting, from 0. Two spaces of indent is one level. */
  depth: number;
}

/**
 * A column's alignment, which GFM writes into the divider row as `---:` or
 * `:---:`.
 *
 * Part of the AST rather than of a renderer because it is **content**: the
 * author wrote it in the document. It is also the one thing on this list that
 * decides whether a column of figures can be read — digits only line up when
 * they are set flush right, and a table of numbers set left is a table nobody
 * checks. The divider was already being matched and its colons thrown away.
 */
export type Align = "left" | "center" | "right";

/**
 * The eight kinds, named one at a time.
 *
 * `Block` is unchanged — the union below is the same shape it always was — but
 * a name lets the *reading* side import the five kinds where a document and a
 * renderer agree (`src/read/blocks.ts`) without importing the two where they do
 * not. A read table carries cell spans and a read document carries pictures,
 * and neither can join this union: `parseMarkdown` cannot produce a span, GFM
 * has no syntax for one, and the four renderers' exhaustive `kind` switches are
 * what make "handled everywhere" a compile error rather than a promise.
 */
export type Heading = { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Run[] };
export type Paragraph = { kind: "paragraph"; runs: Run[] };
export type List = { kind: "list"; ordered: boolean; items: ListItem[] };
export type Code = { kind: "code"; language?: string; text: string };
export type Quote = { kind: "quote"; runs: Run[] };
export type Table = { kind: "table"; header: Run[][]; rows: Run[][][]; align: Align[] };
export type Rule = { kind: "rule" };
/**
 * `:::name` … `:::` — a container that names what its contents *are*.
 *
 * The page renderers unwrap it and render the contents as if the fences were
 * never written, which is the safe meaning everywhere; the PPTX planner reads
 * the name as a slide archetype. Not nested: the first `:::` line closes.
 */
export type Directive = { kind: "directive"; name: string; blocks: Block[] };

export type Block = Heading | Paragraph | List | Code | Quote | Table | Rule | Directive;

export interface MarkdownDocument {
  blocks: Block[];
  /** The first level-1 heading, when there is one, for the document's metadata. */
  title?: string;
}

/** How deep emphasis may nest before the rest is taken literally. */
const MAX_INLINE_DEPTH = 4;
/** How deep a list may indent. Past this, everything is at the last level. */
const MAX_LIST_DEPTH = 4;
/**
 * How deep directives may nest before `:::` is taken literally. Nesting is not
 * a feature — the first close fence closes — but an unclosed open inside an
 * unclosed open recurses, and a hundred thousand of them is a stack, not a
 * document.
 */
const MAX_DIRECTIVE_DEPTH = 4;

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const DIRECTIVE_OPEN = /^:::\s*([a-z][a-z-]*)\s*$/;
const DIRECTIVE_CLOSE = /^:::\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

type Style = Omit<Run, "text">;

/**
 * Characters a backslash may escape, which is the punctuation Markdown gives
 * meaning to.
 *
 * `:` earns its place from the other direction. `escapeInline` has to be able
 * to write any text as a paragraph, and `:::cards` is the one block opener
 * whose marker held no escapable character — so a document that said it came
 * back as a directive nobody wrote. CommonMark escapes every ASCII punctuation
 * mark; this list stays the subset the dialect uses, plus the one it needs to
 * be able to say no with.
 */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~:]/;

function styled(text: string, style: Style): Run {
  return { text, ...style };
}

/**
 * Adjacent runs that look the same are one run.
 *
 * Not cosmetic: a DOCX run and a PDF text-showing operation are each a chunk of
 * markup, and parsing `a*b*c` into three runs where one would do makes the
 * output larger and the line breaker's job harder for no visible difference.
 */
export function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.text === "") {
      continue;
    }
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.code === run.code &&
      last.href === run.href
    ) {
      last.text += run.text;
      continue;
    }
    out.push({ ...run });
  }
  return out;
}

/**
 * `_` inside a word is not emphasis.
 *
 * `snake_case_name` is one word in every language a document might quote, and
 * treating its underscores as emphasis markers eats them — turning an
 * identifier into a different identifier, silently. `*` has no such problem
 * because nothing writes it inside a word.
 */
export function underscoreOpensEmphasis(source: string, index: number): boolean {
  const before = index === 0 ? "" : source[index - 1];
  return before === undefined || before === "" || !/[\p{L}\p{N}_]/u.test(before);
}

export function parseInline(source: string, style: Style = {}, depth = 0): Run[] {
  const runs: Run[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      runs.push(styled(plain, style));
      plain = "";
    }
  };

  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const here = rest[0]!;

    if (here === "\\" && rest.length > 1 && ESCAPABLE.test(rest[1]!)) {
      plain += rest[1];
      index += 2;
      continue;
    }

    if (here === "`") {
      // Code spans win over everything: their contents are literal, which is
      // the entire reason somebody wrote one.
      const code = /^(`+)([\s\S]*?)\1/.exec(rest);
      if (code?.[2] !== undefined) {
        flush();
        runs.push(styled(code[2].trim(), { ...style, code: true }));
        index += code[0].length;
        continue;
      }
    }

    // A link and an image both need a `](` somewhere after the bracket, and the
    // patterns below backtrack across the whole remainder when there is none.
    // 500,000 brackets — `MAX_MARKDOWN_CHARS` exactly — held the event loop for
    // over two minutes on a single-threaded server; this is what makes the cost
    // of *not* being a link a single scan rather than a walk per bracket.
    const closes = here === "[" || (here === "!" && rest[1] === "[") ? rest.indexOf("](") : -1;

    if (here === "!" && rest[1] === "[" && closes !== -1) {
      // Nothing here fetches or embeds pictures, so an image becomes a link to
      // where the picture is. Its label is not parsed as inline markup: alt
      // text is a description, and `*` in it is an asterisk.
      const image = /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (image) {
        const href = image[2]!.replace(/^<|>$/g, "");
        flush();
        // The same escapes a label resolves, and no others: `\\(.)` stripped a
        // backslash that was never an escape, so `![C:\\dir](x)` lost the `d`.
        const alt = image[1]!.replace(/\\([\s\S])/g, (whole, char: string) =>
          ESCAPABLE.test(char) ? char : whole,
        );
        runs.push(styled(alt || "image", { ...style, href }));
        index += image[0].length;
        continue;
      }
    }

    if (here === "[" && closes !== -1) {
      const link = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (link) {
        const href = link[2]!.replace(/^<|>$/g, "");
        const label = link[1] === "" ? href : link[1]!;
        flush();
        runs.push(...parseInline(label, { ...style, href }, depth + 1));
        index += link[0].length;
        continue;
      }
    }

    if ((here === "*" || here === "_") && depth < MAX_INLINE_DEPTH) {
      const opens = here === "*" || underscoreOpensEmphasis(source, index);
      // `(?:\\[\s\S]|[^\\])` rather than `[\s\S]`: a backslash always takes the
      // character after it, so an *escaped* delimiter can never be read as the
      // closing one. Without it `*SELECT \\* FROM t*` closed on the escaped
      // asterisk — the run came back as `SELECT \\` with ` FROM t*` beside it,
      // a backslash in the prose and the asterisk moved to the end. Every
      // reader here produces italic runs, so a document holding an asterisk in
      // an italic phrase reached it.
      const strong = opens ? /^(\*\*|__)(?=\S)((?:\\[\s\S]|[^\\])+?)(?<=\S)\1/.exec(rest) : null;
      if (strong?.[2]) {
        flush();
        runs.push(...parseInline(strong[2], { ...style, bold: true }, depth + 1));
        index += strong[0].length;
        continue;
      }
      const emphasis = opens ? /^(\*|_)(?=\S)((?:\\[\s\S]|[^\\])+?)(?<=\S)\1/.exec(rest) : null;
      if (emphasis?.[2]) {
        flush();
        runs.push(...parseInline(emphasis[2], { ...style, italic: true }, depth + 1));
        index += emphasis[0].length;
        continue;
      }
    }

    plain += here;
    index += 1;
  }
  flush();
  return mergeRuns(runs);
}

/** `| a | b |` → the cells, with the outer pipes and the padding gone. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    // A pipe the caller escaped is a pipe, not a cell boundary.
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/**
 * The divider row's colons, which say how each column is set.
 *
 * `left` is the default and is what a column with no colons has always been
 * rendered as, so a table written before this existed comes out unchanged.
 */
function alignmentsOf(divider: string): Align[] {
  return splitRow(divider).map((cell) => {
    const opens = cell.startsWith(":");
    const closes = cell.endsWith(":");
    if (opens && closes) {
      return "center";
    }
    return closes ? "right" : "left";
  });
}

export function parseMarkdown(source: string, depth = 0): MarkdownDocument {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  /** Consecutive lines that belong to one block, taken while `takes` holds. */
  const gather = (takes: (line: string) => boolean, strip: (line: string) => string): string[] => {
    const out: string[] = [];
    while (index < lines.length && takes(lines[index]!)) {
      out.push(strip(lines[index]!));
      index += 1;
    }
    return out;
  };

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !closing.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      // A fence the caller never closed takes the rest of the document, which is
      // what it says: everything after it is code.
      index += 1;
      const language = fence[2];
      blocks.push({ kind: "code", text: body.join("\n"), ...(language ? { language } : {}) });
      continue;
    }

    const directive = depth < MAX_DIRECTIVE_DEPTH ? DIRECTIVE_OPEN.exec(line) : null;
    if (directive?.[1]) {
      index += 1;
      const inner: string[] = [];
      while (index < lines.length && !DIRECTIVE_CLOSE.test(lines[index]!)) {
        inner.push(lines[index]!);
        index += 1;
      }
      // A directive the caller never closed takes the rest of the document,
      // exactly as an unclosed fence does.
      index += 1;
      blocks.push({
        kind: "directive",
        name: directive[1],
        blocks: parseMarkdown(inner.join("\n"), depth + 1).blocks,
      });
      continue;
    }

    // Ahead of the rule test: `---` is a rule, but `- item` is a list, and a
    // heading's `#` beats both.
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        runs: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = gather(
        (candidate) => QUOTE.test(candidate),
        (candidate) => QUOTE.exec(candidate)?.[1] ?? "",
      );
      blocks.push({ kind: "quote", runs: parseInline(quoted.join(" ").trim()) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = item[3] !== undefined;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index]!);
        if (!next) {
          break;
        }
        // A bullet list and a numbered list next to each other are two lists.
        // Merging them would renumber one of them out of existence.
        if ((next[3] !== undefined) !== ordered) {
          break;
        }
        items.push({
          runs: parseInline(next[4] ?? ""),
          depth: Math.min(Math.floor(next[1]!.length / 2), MAX_LIST_DEPTH),
        });
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (
      isTableRow(line) &&
      index + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[index + 1]!) &&
      splitRow(line).length === splitRow(lines[index + 1]!).length
    ) {
      const header = splitRow(line).map((cell) => parseInline(cell));
      const align = alignmentsOf(lines[index + 1]!);
      index += 2;
      const rows: Run[][][] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(splitRow(lines[index]!).map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows, align });
      continue;
    }

    const paragraph = gather(
      (candidate) =>
        candidate.trim() !== "" &&
        !HEADING.test(candidate) &&
        !RULE.test(candidate) &&
        !FENCE.test(candidate) &&
        !QUOTE.test(candidate) &&
        !LIST_ITEM.test(candidate) &&
        !(depth < MAX_DIRECTIVE_DEPTH && DIRECTIVE_OPEN.test(candidate)),
      (candidate) => candidate.trim(),
    );
    blocks.push({ kind: "paragraph", runs: parseInline(paragraph.join(" ")) });
  }

  const first = blocks.find((block) => block.kind === "heading" && block.level === 1);
  const title = first?.kind === "heading" ? plainTextOf(first.runs) : undefined;
  return { blocks, ...(title ? { title } : {}) };
}

/** The characters of a run list, with the styling dropped. */
export function plainTextOf(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}

/**
 * The document with every directive spliced open.
 *
 * What the page renderers and the summary see: a directive is a PPTX planning
 * hint, and everywhere else its contents stand where it stood.
 */
export function withoutDirectives(document: MarkdownDocument): MarkdownDocument {
  const flatten = (blocks: readonly Block[]): Block[] =>
    blocks.flatMap((block) => (block.kind === "directive" ? flatten(block.blocks) : [block]));
  return { ...document, blocks: flatten(document.blocks) };
}

/**
 * The dialect, written rather than read.
 *
 * The inverse lives beside the parser because that is the only place it can be
 * kept honest: escaping has to cover exactly what parsing gives meaning to, and
 * two files with two lists of the same punctuation drift the first time one of
 * them gains a rule. `opensBlock` is the load-bearing piece — it answers with
 * the parser's own regexes, which stay private, so changing a regex moves both
 * directions at once.
 */

/**
 * Whether a line, standing alone, parses as anything but a paragraph.
 *
 * Every block opener in one predicate: a heading's `#`, a rule, a fence, a
 * quote, a list marker, a `:::` directive fence, and a bare divider row.
 */
export function opensBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    DIRECTIVE_OPEN.test(line) ||
    DIRECTIVE_CLOSE.test(line) ||
    TABLE_DIVIDER.test(line)
  );
}

/**
 * Text, with exactly what `parseInline` would otherwise re-read escaped.
 *
 * `\`, backtick, `*`, `[` and `]` always: the first three open markup wherever
 * they stand, and the brackets are what a link's `\[([^\]]*)\]` reads — a `]`
 * inside a label ends it early and the rest of the label becomes prose.
 *
 * `_` only where it would open emphasis, which is `underscoreOpensEmphasis`'s
 * question and not a second opinion about it. Escaping every one of them would
 * turn `snake_case_name` into `snake\_case\_name` in text a person reads.
 *
 * `!` needs nothing: an image is `![`, and the `[` is already gone.
 */
export function escapeInline(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\" || character === "`" || character === "*" || character === "[" || character === "]") {
      out += `\\${character}`;
      continue;
    }
    if (character === "_" && underscoreOpensEmphasis(text, index)) {
      out += "\\_";
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * A line written where a block may start, with its opener defused.
 *
 * The escape is chosen by asking `opensBlock` again rather than by knowing
 * which marker matched: `1. ` needs the `.` escaped and not the `1`, `|---|`
 * needs its first pipe, and a rule needs its first dash. One loop over the
 * marker's own characters answers all of them, and cannot disagree with the
 * predicate it is defusing.
 */
export function escapeLineStart(text: string): string {
  if (!opensBlock(text)) {
    return text;
  }
  // A marker is punctuation and a little whitespace; past that the line is
  // prose and escaping inside it would be noise for nothing.
  const reach = Math.min(text.length, 16);
  for (let index = 0; index < reach; index += 1) {
    if (!ESCAPABLE.test(text[index]!)) {
      continue;
    }
    const defused = `${text.slice(0, index)}\\${text.slice(index)}`;
    if (!opensBlock(defused)) {
      return defused;
    }
  }
  return text;
}

/**
 * A code span's fence: one backtick longer than the longest run inside it.
 *
 * Mirrors the parser's `` /^(`+)([\s\S]*?)\1/ ``, which is what lets a span
 * hold backticks at all.
 */
function fenceInline(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  // A span that begins or ends with a backtick fuses with its own fence, and
  // the parser then reads a shorter span and leaves the rest as prose. One
  // space on each side is what CommonMark strips back off — and this parser
  // trims, so it comes back the same way.
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/**
 * Emphasis delimiters need something other than a space beside them.
 *
 * `parseInline` requires `(?=\S)` after the opener and `(?<=\S)` before the
 * closer, so `**  bold  **` is not bold — it is four asterisks and a word. The
 * padding is re-emitted outside the delimiters, and a run that is nothing but
 * whitespace gets none at all. This is the quietest way for a serializer to be
 * wrong: nothing errors, the emphasis simply stops being emphasis.
 */
function wrap(text: string, delimiter: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const lead = match?.[1] ?? "";
  const core = match?.[2] ?? "";
  const trail = match?.[3] ?? "";
  return core === "" ? text : `${lead}${delimiter}${core}${delimiter}${trail}`;
}

/** A link target, angled when it holds what would end it early. */
function linkTarget(href: string): string {
  if (!/[\s()<>]/.test(href)) {
    return href;
  }
  // `<[^>]*>` is what the parser accepts, so a `>` inside the target has to
  // stop being one. Percent-encoding is what a URL does with it anyway.
  return `<${href.replace(/>/g, "%3E")}>`;
}

/**
 * A picture as `![alt](target)`.
 *
 * The alt text is escaped like any other text, and for the same reason a link
 * label is: a bracket inside it ends the label early. Unescaped, an alt of
 * `a](x) b` writes `![a](x) b](m.png)`, which reads back as a *link* to `x`
 * followed by stray characters — the caption gone and an address invented.
 */
export function renderImage(alt: string, target: string): string {
  return `![${escapeInline(alt)}](${linkTarget(target)})`;
}

/**
 * A fenced block's info string, which is one word and no backticks.
 *
 * `FENCE` captures `[^`\s]*`, so anything else in a language is not read back
 * as one — and a backtick in it closes the fence it was supposed to open.
 */
export function fenceLanguage(language: string): string {
  return language.replace(/`/g, "").trim().split(/\s+/)[0] ?? "";
}

/** Runs as Markdown: `**bold**`, `` `code` ``, `[label](href)`. */
export function renderRuns(runs: readonly Run[]): string {
  const written = mergeRuns(runs)
    .map((run) => {
      // A code span's contents are literal, so a `]` inside one ends the link
      // label it would sit in and leaves `](url)` standing in the prose — the
      // failure `renderImage` exists to prevent, in its code-span form. The
      // link is the one that carries an address, so it is the one that is kept.
      const code = run.code === true && run.href === undefined;
      let text = code ? fenceInline(run.text) : escapeInline(run.text);
      // `***x***` is not bold italic to this parser: the strong pattern is lazy,
      // so it closes on the first `**` it reaches and leaves an asterisk behind.
      // The inner delimiter has to be the other one — and it is the *inner* one
      // because `_` only opens emphasis after a non-word character, which `*`
      // always is and the run before this one may not be.
      if (run.italic) {
        text = wrap(text, run.bold ? "_" : "*");
      }
      if (run.bold) {
        text = wrap(text, "**");
      }
      return run.href ? `[${text}](${linkTarget(run.href)})` : text;
    });
  // A link writes a real `[`, so a run ending in `!` beside one spells `![`
  // and the pair is read back as an image — the exclamation mark eaten and the
  // link turned into a picture. `escapeInline` cannot see it: the `!` and the
  // `[` belong to different runs.
  return written
    .map((part, index) =>
      part.endsWith("!") && written[index + 1]?.startsWith("[")
        ? `${part.slice(0, -1)}\\!`
        : part,
    )
    .join("");
}
