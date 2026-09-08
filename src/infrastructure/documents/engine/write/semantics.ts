/**
 * What a run of blocks *is*, recognised from its shape — with no format in it.
 *
 * Markdown says what to show and none of how; these functions read the
 * structure the author already wrote — three sub-headings with a line each, a
 * list of numbers, a lone block quote — and name the semantic that structure
 * was reaching for. The PPTX planner turns a semantic into a designed slide;
 * a page renderer may turn the same one into a styled block, or leave it as
 * the plain flow it already renders well. Recognition is shared; what to make
 * of it is each format's own decision.
 *
 * **Every rule here is conservative.** Content that does not match a pattern
 * *exactly* stays unrecognised, because a treatment forced onto content it
 * does not fit is worse than plain rendering — a "cards" slide with a code
 * block wedged into a card is how generated documents get their reputation.
 * When a rule says 2 to 4, a fifth card means the section was prose after all.
 */

import type { Block, Run } from "../markdown";
import { plainTextOf } from "../markdown";

/** One card: a sub-heading and at most a line or two under it. */
export interface Card {
  title: Run[];
  body?: Run[];
}

/** One metric: the number, and what the number is of. */
export interface Metric {
  value: string;
  label: Run[];
}

/** One line in a comparison column, bulleted when it came from a list. */
export interface CompareLine {
  runs: Run[];
  bullet: boolean;
}

/** One side of a comparison: its name, and its lines. */
export interface CompareColumn {
  title: Run[];
  lines: CompareLine[];
}

/** One station on a timeline: when, and what happened there. */
export interface Milestone {
  when: string;
  what: Run[];
}

/** A figure: one image reference standing alone, with its caption. */
export interface Figure {
  /** The asset's name — the key the caller sent the bytes under. */
  asset: string;
  caption: Run[];
}

/** What a run of blocks turned out to be. */
export type Semantic =
  | { kind: "cards"; cards: Card[] }
  | { kind: "metrics"; metrics: Metric[] }
  | { kind: "quote"; quote: Run[]; attribution?: Run[] }
  | { kind: "comparison"; columns: [CompareColumn, CompareColumn] }
  | { kind: "process"; steps: Run[][] }
  | { kind: "timeline"; milestones: Milestone[] };

/** How much text fits a card before the card is prose. */
const CARD_BODY_LIMIT = 160;
/** A metric line: short enough to be a figure with a name. */
const METRIC_LIMIT = 44;
const METRIC_VALUE_LIMIT = 12;
/** A metric's name is a few words; more words make it a sentence. */
const METRIC_LABEL_TOKENS = 4;
/** An attribution is a line, not a paragraph, and it announces itself. */
const ATTRIBUTION_LIMIT = 80;
const ATTRIBUTION_LEAD = /^[—–-]/;
/** Lines one comparison column holds before it is a table's job. */
const COMPARE_LINE_LIMIT = 6;

/** A process step has to fit in a node; a sentence does not. */
const STEP_LIMIT = 48;
/** What a timeline says happened has to fit under its station. */
const MILESTONE_LIMIT = 40;

/** A comparison needs the title to say it is one: "A vs B", "도입 비교". */
const COMPARISON_TITLE = /(^|\s)vs\.?(\s|$)|비교/i;

/**
 * A token that names a time: 2026, 2026년, Q3, 8월, 3분기, 2주차. The whole
 * token must be the date — "2026년의" is prose about a year, not a station.
 */
const WHEN = /^(20\d{2}년?|q[1-4]|\d{1,2}월|\d{1,2}분기|\d{1,2}주차?)$/i;

/** The `asset://` scheme, which is how Markdown reaches the bytes the caller sent. */
export const ASSET_SCHEME = "asset://";

/**
 * Korean, and only Korean: the syllables 가–힣 (U+AC00–U+D7A3, 힣 being the
 * last of them) plus the compatibility jamo.
 *
 * Two explicit ranges, never one from jamo to syllables: a single span like
 * `ㄱ-힣` crosses the kana and han blocks that sit between, and a Japanese or
 * Chinese document must not test as Korean. Shared from here because four
 * renderers ask the same question and a subtle character class is exactly the
 * thing that drifts when copied.
 */
export const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

function isSubheading(block: Block): block is Extract<Block, { kind: "heading" }> {
  return block.kind === "heading" && block.level >= 3;
}

/**
 * Cards: 2 to 4 sub-headings, each followed by at most one short paragraph.
 *
 * The all-heading shape is what an author writes when they mean a set of
 * parallel things — 핵심 가치, three pillars, four features. Anything else in
 * the section (a list, a code block, a second paragraph) means the headings
 * were structure, not a set.
 */
export function cardsOf(blocks: readonly Block[]): Semantic | undefined {
  const cards: Card[] = [];
  for (const block of blocks) {
    if (isSubheading(block)) {
      cards.push({ title: block.runs });
      continue;
    }
    const last = cards[cards.length - 1];
    if (
      block.kind === "paragraph" &&
      last &&
      !last.body &&
      plainTextOf(block.runs).length <= CARD_BODY_LIMIT
    ) {
      last.body = block.runs;
      continue;
    }
    return undefined;
  }
  if (cards.length < 2 || cards.length > 4) {
    return undefined;
  }
  return { kind: "cards", cards };
}

/**
 * Metrics: one bullet list of 2 to 4 short lines, each a figure with a name —
 * "99.99% Availability", "가용성 99.99%". The figure may lead or trail; it must
 * be one token with a digit in it, and the name must be the rest.
 */
export function metricsOf(blocks: readonly Block[]): Semantic | undefined {
  const [list] = blocks;
  if (blocks.length !== 1 || list?.kind !== "list" || list.ordered) {
    return undefined;
  }
  if (list.items.length < 2 || list.items.length > 4) {
    return undefined;
  }
  const metrics: Metric[] = [];
  for (const item of list.items) {
    if (item.depth !== 0) {
      return undefined;
    }
    const text = plainTextOf(item.runs).trim();
    if (text.length > METRIC_LIMIT) {
      return undefined;
    }
    const tokens = text.split(/\s+/);
    if (tokens.length < 2 || tokens.length > METRIC_LABEL_TOKENS + 1) {
      return undefined;
    }
    const leads = /\d/.test(tokens[0]!) && tokens[0]!.length <= METRIC_VALUE_LIMIT;
    const trails = /\d/.test(tokens[tokens.length - 1]!) && tokens[tokens.length - 1]!.length <= METRIC_VALUE_LIMIT;
    if (leads) {
      metrics.push({ value: tokens[0]!, label: [{ text: tokens.slice(1).join(" ") }] });
    } else if (trails) {
      metrics.push({ value: tokens[tokens.length - 1]!, label: [{ text: tokens.slice(0, -1).join(" ") }] });
    } else {
      return undefined;
    }
  }
  return { kind: "metrics", metrics };
}

/**
 * A pulled quote: one block quote alone, or with a single short dash-led line
 * after it — "— 운영팀 리드". A paragraph that does not announce itself as an
 * attribution means the quote was part of an argument.
 */
export function quoteOf(blocks: readonly Block[]): Semantic | undefined {
  const [quote, attribution, ...rest] = blocks;
  if (quote?.kind !== "quote" || rest.length > 0) {
    return undefined;
  }
  if (attribution === undefined) {
    return { kind: "quote", quote: quote.runs };
  }
  if (attribution.kind !== "paragraph") {
    return undefined;
  }
  const line = plainTextOf(attribution.runs).trim();
  if (!ATTRIBUTION_LEAD.test(line) || line.length > ATTRIBUTION_LIMIT) {
    return undefined;
  }
  return { kind: "quote", quote: quote.runs, attribution: attribution.runs };
}

/**
 * The two-column shape itself, with no opinion about the title: exactly two
 * sub-headings, each followed by short lists or paragraphs. Two named columns
 * is the shape; three is a cards section, and prose under one heading is not
 * a comparison at all.
 */
export function columnsOf(blocks: readonly Block[]): Semantic | undefined {
  const columns: CompareColumn[] = [];
  for (const block of blocks) {
    if (isSubheading(block)) {
      columns.push({ title: block.runs, lines: [] });
      continue;
    }
    const column = columns[columns.length - 1];
    if (!column) {
      return undefined;
    }
    if (block.kind === "paragraph") {
      column.lines.push({ runs: block.runs, bullet: false });
      continue;
    }
    if (block.kind === "list") {
      if (block.ordered || block.items.some((item) => item.depth !== 0)) {
        return undefined;
      }
      for (const item of block.items) {
        column.lines.push({ runs: item.runs, bullet: true });
      }
      continue;
    }
    return undefined;
  }
  if (columns.length !== 2) {
    return undefined;
  }
  for (const column of columns) {
    if (column.lines.length === 0 || column.lines.length > COMPARE_LINE_LIMIT) {
      return undefined;
    }
  }
  return { kind: "comparison", columns: [columns[0]!, columns[1]!] };
}

/** A comparison recognised without being asked also needs the title to say "vs". */
export function comparisonOf(title: readonly Run[], blocks: readonly Block[]): Semantic | undefined {
  if (!COMPARISON_TITLE.test(plainTextOf(title))) {
    return undefined;
  }
  return columnsOf(blocks);
}

/** The lone flat ordered list a process or a timeline is made of, or nothing. */
function orderedItems(blocks: readonly Block[], most: number): Run[][] | undefined {
  const [list] = blocks;
  if (blocks.length !== 1 || list?.kind !== "list" || !list.ordered) {
    return undefined;
  }
  if (list.items.length < 3 || list.items.length > most) {
    return undefined;
  }
  if (list.items.some((item) => item.depth !== 0)) {
    return undefined;
  }
  return list.items.map((item) => item.runs);
}

/**
 * A timeline: an ordered list whose every step opens with a date — 2026년,
 * Q3, 8월. All of them, not most: one undated step means the author was
 * writing a sequence of actions, which is a process.
 */
export function timelineOf(blocks: readonly Block[]): Semantic | undefined {
  const items = orderedItems(blocks, 6);
  if (!items) {
    return undefined;
  }
  const milestones: Milestone[] = [];
  for (const runs of items) {
    const text = plainTextOf(runs).trim();
    const tokens = text.split(/\s+/);
    if (tokens.length < 2 || !WHEN.test(tokens[0]!)) {
      return undefined;
    }
    const rest = tokens.slice(1).join(" ");
    if (rest.length > MILESTONE_LIMIT) {
      return undefined;
    }
    milestones.push({ when: tokens[0]!, what: [{ text: rest }] });
  }
  return { kind: "timeline", milestones };
}

/**
 * A process: three to five short ordered steps, each of which fits in a node.
 * The numbers the author wrote become the numbers in the nodes, so nothing is
 * renumbered and nothing is lost if the section falls back to a plain list.
 */
export function processOf(blocks: readonly Block[]): Semantic | undefined {
  const items = orderedItems(blocks, 5);
  if (!items) {
    return undefined;
  }
  if (items.some((runs) => plainTextOf(runs).length > STEP_LIMIT)) {
    return undefined;
  }
  return { kind: "process", steps: items.map((runs) => [...runs]) };
}

/**
 * A paragraph that is exactly one `![caption](asset://…)` image. The parser
 * turned the image into a link run carrying the alt text, so this is a
 * paragraph of one asset-scheme link — anything more around it means the image
 * was an illustration inside prose, which stays a link.
 */
export function figureOf(block: Block | undefined): Figure | undefined {
  if (block?.kind !== "paragraph" || block.runs.length !== 1) {
    return undefined;
  }
  const [run] = block.runs;
  if (!run?.href?.startsWith(ASSET_SCHEME)) {
    return undefined;
  }
  return { asset: run.href.slice(ASSET_SCHEME.length), caption: [{ text: run.text }] };
}

/** What a cover holds: the opening title, and the paragraph right under it. */
export interface Cover {
  title: Run[];
  subtitle?: Run[];
}

/**
 * The opening `#` and its first paragraph, when the document leads with them.
 *
 * The same reading everywhere: the first `#` is the cover's title, the
 * paragraph right under it the subtitle, and both leave the body. What a
 * format *makes* of the cover — a title page, a title slide — is its own
 * decision; that the document has one is not.
 */
export function coverOf(blocks: readonly Block[]): { cover?: Cover; body: readonly Block[] } {
  const [first, second] = blocks;
  if (first?.kind !== "heading" || first.level !== 1) {
    return { body: blocks };
  }
  if (second?.kind === "paragraph") {
    return { cover: { title: first.runs, subtitle: second.runs }, body: blocks.slice(2) };
  }
  return { cover: { title: first.runs }, body: blocks.slice(1) };
}

/** How many level 1-2 headings a body needs before a contents page earns its paper. */
export const TOC_THRESHOLD = 3;

/** The level 1-2 headings a contents page lists, in order. */
export function tocEntriesOf(
  blocks: readonly Block[],
): { runs: Run[]; level: number }[] {
  return blocks
    .filter((block): block is Extract<Block, { kind: "heading" }> => block.kind === "heading")
    .filter((block) => block.level <= 2)
    .map((block) => ({ runs: block.runs, level: block.level }));
}

/**
 * The first semantic the blocks' shape matches, or nothing.
 *
 * Order matters only where patterns could overlap, and they barely can: a
 * comparison requires its title to say so, so it is asked first; cards and
 * metrics are disjoint (headings against a list); process and timeline split
 * an ordered list between them; a quote shares nothing with any.
 */
export function recognise(title: readonly Run[] | undefined, blocks: readonly Block[]): Semantic | undefined {
  if (!title || blocks.length === 0) {
    return undefined;
  }
  return (
    comparisonOf(title, blocks) ??
    cardsOf(blocks) ??
    metricsOf(blocks) ??
    timelineOf(blocks) ??
    processOf(blocks) ??
    quoteOf(blocks)
  );
}

/**
 * The semantic a `:::name` directive asked for, tried against its contents.
 *
 * A directive overrides *recognition*, not fit: it skips the guards that exist
 * only to avoid surprising an author — the "vs" a comparison title must say —
 * and keeps the ones that are about what fits, because five cards do not fit a
 * row however clearly they were requested. Content that cannot form the named
 * semantic falls back to plain rendering rather than failing the render.
 */
export function forceSemantic(name: string, blocks: readonly Block[]): Semantic | undefined {
  switch (name) {
    case "cards":
      return cardsOf(blocks);
    case "metrics":
      return metricsOf(blocks);
    case "comparison":
      return columnsOf(blocks);
    case "timeline":
      return timelineOf(blocks);
    case "process":
      return processOf(blocks);
    case "quote":
      return quoteOf(blocks);
    default:
      return undefined;
  }
}
