/**
 * Markdown in, a presentation out — the deck's decisions, with no XML in them.
 *
 * A deck is a sequence of fixed-size boxes, so unlike the DOCX and HWPX writers
 * this planner has to decide **where a slide ends** — there is no reflow to fall
 * back on, and text past the bottom of a box is simply not on the screen.
 *
 * **A slide opens at a level 1 or 2 heading**, and the level says what opens.
 * A `#` that starts the document is the cover; a `#` later is a section
 * divider, numbered in the order the dividers appear; a `##` is an ordinary
 * content slide. Nothing else in Markdown says "new slide" — a horizontal
 * rule, which is what Marp uses, turns a decorative divider into a page break
 * in every document that was not written as a deck. Level 3 and below stay in
 * the body as sub-headings.
 *
 * **A cover holds a title and a subtitle, nothing more.** The first paragraph
 * under the opening `#` is the subtitle; every other block moves past the
 * cover, because a list on a title page is a list that belongs on the next
 * slide. A divider works the same way: the slide is the title, and the
 * section's blocks follow on content slides of their own.
 *
 * **Content that does not fit continues on the next slide**, titled with
 * `(계속)`. The line count is `layout.ts`'s estimate, in the same
 * character-width currency `write/table.ts` uses for column widths.
 *
 * **Blocks are flattened to lines before anything is packed.** A list becomes one
 * piece per item with its marker already resolved, which is what lets a numbered
 * list be split across two slides and still count 4, 5, 6 rather than starting
 * again at 1. Only a table stays whole, and it splits by row with its header
 * repeated.
 */

import type { Block, MarkdownDocument, Run } from "../../markdown";
import { plainTextOf } from "../../markdown";
import { designFor, type DesignProfile } from "../theme";
import { figureOf, forceSemantic, recognise, type Semantic } from "../semantics";
import {
  BODY_LINES,
  BODY_SIZE,
  CLOSING_LINES,
  CODE_SIZE,
  LINE_HEIGHT,
  ROW_HEIGHT,
  SUBHEADING_SIZES,
  linesOf,
} from "./layout";
import type { Piece, Presentation, Slide, Style } from "./types";

/** What a continued slide's title says, so the reader knows it is not a new topic. */
export const CONTINUED = " (계속)";

/**
 * Titles that say the deck is over.
 *
 * The one archetype that is *recognised* rather than declared, and the match is
 * deliberately narrow: a heading whose whole job is to close — 감사합니다,
 * Thank you, Q&A — and only when it is the last section of the document.
 * Recognising "다음 단계" here would turn a roadmap into a goodbye.
 */
const CLOSING_TITLE = /^(감사합니다|고맙습니다|thank\s*you|thanks|q\s*&?\s*a|질문|문의)[.!?。！？]*$/i;

const BODY_STYLE: Style = { size: BODY_SIZE, indent: 0 };

function piecesOf(block: Block, design: DesignProfile): Piece[] {
  switch (block.kind) {
    case "heading":
      // Levels 1 and 2 opened a slide and never reach here; 3 to 6 are set as
      // bold sub-headings, which is what they read as on a slide. `opens` is
      // for the packer: a break lands better just before a topic than inside
      // one.
      return [
        {
          kind: "text",
          runs: block.runs,
          opens: true,
          style: {
            size: SUBHEADING_SIZES[Math.min(block.level, 6) - 3] ?? BODY_SIZE,
            bold: true,
            colour: design.palette.brand,
            indent: 0,
            before: 600,
          },
        },
      ];
    case "paragraph":
      return [{ kind: "text", runs: block.runs, style: BODY_STYLE }];
    case "list": {
      // The marker is resolved here rather than at render time, which is what
      // lets a numbered list survive being split across two slides. It is a
      // brand-coloured run — the one place a content slide affords a drop of
      // colour without putting a field behind anything.
      const counters: number[] = [];
      return block.items.map((item) => {
        counters.length = item.depth + 1;
        counters[item.depth] = (counters[item.depth] ?? 0) + 1;
        const marker = block.ordered ? `${counters[item.depth]}. ` : "• ";
        return {
          kind: "text",
          runs: [{ text: marker }, ...item.runs],
          style: { size: BODY_SIZE, indent: item.depth + 1, marker: design.palette.brandLight },
        };
      });
    }
    case "code":
      return (block.text === "" ? [""] : block.text.split("\n")).map((line) => ({
        kind: "text",
        runs: [{ text: line }],
        style: { size: CODE_SIZE, mono: true, indent: 1 },
      }));
    case "quote":
      return [
        {
          kind: "text",
          runs: block.runs,
          style: { size: BODY_SIZE, italic: true, colour: design.palette.inkMuted, indent: 1 },
        },
      ];
    case "table":
      return [{ kind: "table", header: block.header, rows: block.rows, align: block.align }];
    case "rule":
      // A drawn line would be a shape of its own in the middle of a text box,
      // which is a second layout problem for a mark this small. The same row of
      // dashes `write/hwpx.ts` settles for.
      return [
        {
          kind: "text",
          runs: [{ text: "─".repeat(30) }],
          style: { size: BODY_SIZE, colour: design.palette.rule, indent: 0 },
        },
      ];
    case "directive":
      // On a slide that is not the archetype it asked for, a directive's
      // contents stand where it stood — same rule as the page renderers.
      return block.blocks.flatMap((inner) => piecesOf(inner, design));
  }
}

/**
 * A table cut to `rows` data rows, and what is left of it.
 *
 * The header repeats on the second half, because a column of numbers with no
 * heading above it is a column nobody can read.
 */
function splitTable(
  piece: Extract<Piece, { kind: "table" }>,
  rows: number,
): { head: Piece; rest: Piece } | undefined {
  if (rows < 1 || rows >= piece.rows.length) {
    return undefined;
  }
  return {
    head: { kind: "table", header: piece.header, rows: piece.rows.slice(0, rows), align: piece.align },
    rest: { kind: "table", header: piece.header, rows: piece.rows.slice(rows), align: piece.align },
  };
}

/** Fill slides with pieces, greedily, `budget` lines to a slide. */
function pack(pieces: readonly Piece[], budget: number): Piece[][] {
  const slides: Piece[][] = [];
  let current: Piece[] = [];
  let used = 0;

  const flush = (): void => {
    if (current.length > 0) {
      slides.push(current);
      current = [];
      used = 0;
    }
  };

  for (const piece of pieces) {
    let pending: Piece | undefined = piece;
    while (pending) {
      const room = budget - used;
      const cost = linesOf(pending);
      if (cost <= room) {
        current.push(pending);
        used += cost;
        pending = undefined;
        continue;
      }
      if (room > 0 && pending.kind === "table") {
        // A table is the one piece worth cutting mid-way: its rows are
        // independent, and moving the whole thing leaves a slide half empty.
        const rows = Math.max(1, Math.floor((room * LINE_HEIGHT) / ROW_HEIGHT) - 1);
        const split = splitTable(pending, rows);
        if (split) {
          current.push(split.head);
          flush();
          pending = split.rest;
          continue;
        }
      }
      if (current.length === 0) {
        // Nothing to move it past: a single piece taller than a slide goes on
        // one anyway, and PowerPoint's autofit shrinks what is left over.
        current.push(pending);
        flush();
        pending = undefined;
        continue;
      }
      // The slide is full. Prefer to break just before the last sub-heading on
      // it: "Control Plane" and its first line on one slide, the rest on the
      // next, is a topic split in half — moving the heading keeps it whole.
      const cut = current.reduce(
        (found, candidate, at) => (candidate.kind === "text" && candidate.opens ? at : found),
        0,
      );
      if (cut > 0) {
        const moved = current.slice(cut);
        current = current.slice(0, cut);
        flush();
        current = moved;
        used = moved.reduce((sum, one) => sum + linesOf(one), 0);
        continue;
      }
      flush();
    }
  }
  flush();
  return slides;
}

/** What one heading (or the headingless head of a document) turned out to own. */
interface Section {
  /** `cover` is the opening `#`; `divider` is any later one; `body` is a `##`. */
  kind: "cover" | "divider" | "body";
  title?: Run[];
  blocks: Block[];
}

/** Cut the document at every level 1 and 2 heading. */
function sectionsOf(document: MarkdownDocument): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const block of document.blocks) {
    if (block.kind === "heading" && block.level <= 2) {
      // Only a document that *opens* with a level 1 heading gets a cover: a `#`
      // halfway down is a new chapter, and centring its title would read as the
      // deck starting over. It gets a divider instead.
      const cover = sections.length === 0 && block.level === 1;
      current = {
        kind: cover ? "cover" : block.level === 1 ? "divider" : "body",
        title: block.runs,
        blocks: [],
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { kind: "body", blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  return sections.length > 0 ? sections : [{ kind: "body", blocks: [] }];
}

/**
 * Content slides for a section's blocks: the first carries `title`, the rest
 * continue it.
 *
 * A continuation that *starts on a sub-heading* is titled with it — "아키텍처
 * — Control Plane" — and the heading leaves the body, because it is now the
 * title. Only a continuation that starts mid-flow falls back to `(계속)`,
 * which tells the reader the break was mechanical rather than meant.
 */
function contentSlides(
  title: Run[] | undefined,
  blocks: readonly Block[],
  design: DesignProfile,
): Slide[] {
  const pages = pack(blocks.flatMap((block) => piecesOf(block, design)), BODY_LINES);
  if (pages.length === 0) {
    return title ? [{ type: "content", title, pieces: [] }] : [];
  }
  return pages.map((pieces, index) => {
    if (index === 0 || !title) {
      return { type: "content", pieces, ...(title ? { title } : {}) };
    }
    const [head, ...rest] = pieces;
    if (head?.kind === "text" && head.opens && rest.length > 0) {
      return {
        type: "content",
        title: [...title, { text: " — " }, ...head.runs],
        pieces: rest,
        continuation: true,
      };
    }
    return {
      type: "content",
      title: [...title, { text: CONTINUED }],
      pieces,
      continuation: true,
    };
  });
}

/** A recognised semantic, given the section's title, as the slide it plans. */
function slideOf(semantic: Semantic, title: Run[]): Slide {
  switch (semantic.kind) {
    case "cards":
      return { type: "cards", title, cards: semantic.cards };
    case "metrics":
      return { type: "metrics", title, metrics: semantic.metrics };
    case "quote":
      return {
        type: "quote",
        title,
        quote: semantic.quote,
        ...(semantic.attribution ? { attribution: semantic.attribution } : {}),
      };
    case "comparison":
      return { type: "comparison", title, columns: semantic.columns };
    case "process":
      return { type: "process", title, steps: semantic.steps };
    case "timeline":
      return { type: "timeline", title, milestones: semantic.milestones };
  }
}

/** True when this section should close the deck rather than continue it. */
function closes(section: Section, last: boolean): boolean {
  return (
    last &&
    section.title !== undefined &&
    CLOSING_TITLE.test(plainTextOf(section.title).trim())
  );
}

export function plan(document: MarkdownDocument, design: DesignProfile = designFor()): Presentation {
  const sections = sectionsOf(document);
  const slides: Slide[] = [];
  let ordinal = 0;

  sections.forEach((section, index) => {
    const last = index === sections.length - 1;

    if (section.kind === "cover") {
      // The first paragraph is the subtitle; everything else moves past the
      // cover onto untitled content slides. A cover that keeps its lists is a
      // cover that reads as a crowded content slide.
      const [head, ...rest] = section.blocks;
      const subtitle = head?.kind === "paragraph" ? head.runs : undefined;
      const carried = head?.kind === "paragraph" ? rest : section.blocks;
      slides.push({
        type: "cover",
        title: section.title ?? [],
        ...(subtitle ? { subtitle } : {}),
      });
      slides.push(...contentSlides(undefined, carried, design));
      return;
    }

    if (closes(section, last)) {
      // The closing holds what fits under its centred title; a closing slide
      // with more to say than that is a content section that ends the deck.
      const pieces = section.blocks.flatMap((block) => piecesOf(block, design));
      const pages = pack(pieces, CLOSING_LINES);
      if (pages.length <= 1) {
        slides.push({ type: "closing", title: section.title ?? [], pieces: pages[0] ?? [] });
        return;
      }
    }

    if (section.kind === "divider") {
      ordinal += 1;
      slides.push({ type: "section", title: section.title ?? [], ordinal });
      if (section.blocks.length > 0) {
        slides.push(...contentSlides(section.title, section.blocks, design));
      }
      return;
    }

    // A section that is one image and nothing else is an image slide: the
    // picture takes the body, and its alt text is the caption.
    const figure = section.blocks.length === 1 ? figureOf(section.blocks[0]) : undefined;
    if (figure && section.title) {
      slides.push({ type: "image", title: section.title, ...figure });
      return;
    }

    // A `:::name` directive filling the whole section says what the slide is;
    // recognition handles the sections that never asked. Either way, content
    // that cannot form the archetype falls back to a plain slide.
    const [only] = section.blocks;
    if (section.blocks.length === 1 && only?.kind === "directive" && section.title) {
      const forced = forceSemantic(only.name, only.blocks);
      if (forced) {
        slides.push(slideOf(forced, section.title));
        return;
      }
    }
    const recognised = recognise(section.title, section.blocks);
    if (recognised && section.title) {
      slides.push(slideOf(recognised, section.title));
      return;
    }
    slides.push(...contentSlides(section.title, section.blocks, design));
  });

  return { slides: slides.length > 0 ? slides : [{ type: "content", pieces: [] }] };
}
