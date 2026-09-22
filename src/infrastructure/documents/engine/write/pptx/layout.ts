/**
 * Slide geometry, and the arithmetic that estimates what fits.
 *
 * Everything here is in EMU — 914,400 to the inch, which is what every
 * DrawingML measurement is in — derived from the point scale `write/theme.ts`
 * decides. The line count is an estimate: nothing here measures a font, because
 * unlike the PDF renderer this package embeds none and cannot know what the
 * reader's PowerPoint will substitute. Being a line out puts a line nearer the
 * edge than intended, which is a better failure than letting a slide overflow
 * and lose it.
 */

import type { Run } from "../../markdown";
import { DECK, LEADING, centiPoints, emu } from "../theme";
import type { Piece } from "./types";

/** EMU, which is what every DrawingML measurement is in: 914,400 to the inch. */
export const EMU_PER_POINT = 12700;

/** 16:9, which is what every deck has been since PowerPoint 2013. */
export const SLIDE_WIDTH = 12192000;
export const SLIDE_HEIGHT = 6858000;

export const SIDE_MARGIN = 685800;
export const CONTENT_WIDTH = SLIDE_WIDTH - SIDE_MARGIN * 2;

/** The title bar of an ordinary slide, and the body beneath it. */
export const TITLE_BOX = { y: 457200, height: 1143000 };
export const BODY_BOX = { y: 1714500, height: 4457700 };

/**
 * The cover's composition: a title in the upper-middle third, a subtitle under
 * it, and everything else on the slide belonging to the layout rather than the
 * content. What a cover does not hold any more is arbitrary pieces — a list on
 * a title page is a list that belongs on the next slide, and the planner sends
 * it there.
 */
export const COVER_TITLE_BOX = { y: 2209800, height: 1600200 };
export const SUBTITLE_BOX = { y: 3886200, height: 914400 };

/**
 * A section divider: the ordinal above, the title below, a rule between.
 * The boxes are generous because a 66pt numeral and a 40pt title need air —
 * a divider that is cramped reads as a content slide that lost its body.
 */
export const SECTION_ORDINAL_BOX = { y: 1524000, height: 1066800 };
export const SECTION_TITLE_BOX = { y: 3048000, height: 1219200 };

/** The closing slide, centred where the cover is flush left. */
export const CLOSING_TITLE_BOX = { y: 2590800, height: 1143000 };
export const CLOSING_BODY_BOX = { y: 3886200, height: 1371600 };

/**
 * The accent rule a cover and a divider carry above their titles — wider and
 * heavier than the one under a content slide's title, because on those two
 * slides it is the only horizontal mark on the page.
 */
export const HEAD_RULE = { width: emu(48), height: emu(4.5) };
/** Where the rule sits: this far above the title box it introduces. */
export const HEAD_RULE_GAP = emu(15);

/* ------------------------------------------------- archetype geometry */

/** The gap between cards, columns and metric cells. */
export const GRID_GAP = 274320;

/**
 * Cards sit in one row across the body, vertically centred. The height is
 * fixed rather than fitted: four equal boxes are what makes a row read as a
 * set, and a card with less to say holds its size.
 */
export const CARD_HEIGHT = 2743200;
export const CARD_TOP = BODY_BOX.y + Math.round((BODY_BOX.height - CARD_HEIGHT) / 2);
/** The padding inside a card between its edge and its text. */
export const CARD_INSET = 228600;

/** A metric's number sits high in the body, its label right under it. */
export const METRIC_VALUE_BOX = { y: BODY_BOX.y + 1143000, height: 914400 };
export const METRIC_LABEL_BOX = { y: BODY_BOX.y + 2057400, height: 457200 };

/** The pulled quote: a bar at the margin, the text indented past it. */
export const QUOTE_BAR_WIDTH = emu(4.5);
export const QUOTE_INDENT = 457200;
export const QUOTE_BOX = { y: BODY_BOX.y + 685800, height: 1828800 };
export const ATTRIBUTION_BOX = { y: QUOTE_BOX.y + QUOTE_BOX.height + emu(12), height: 457200 };

/** Comparison columns: a pill-shaped header chip, the lines hanging under it. */
export const COMPARE_GAP = 457200;
export const CHIP_HEIGHT = 457200;
export const COMPARE_BODY_TOP = BODY_BOX.y + CHIP_HEIGHT + emu(18);

/** Process nodes: a row of rounded boxes, an arrow in every gap. */
export const PROCESS_NODE_HEIGHT = 1371600;
export const PROCESS_NODE_TOP = BODY_BOX.y + Math.round((BODY_BOX.height - PROCESS_NODE_HEIGHT) / 2);
export const PROCESS_GAP = 457200;
export const PROCESS_ARROW = { width: 274320, height: 205740 };

/** An image slide: the picture's box, and the caption line under it. */
export const IMAGE_BOX = {
  x: SIDE_MARGIN,
  y: BODY_BOX.y,
  width: CONTENT_WIDTH,
  height: BODY_BOX.height - 533400,
};
export const IMAGE_CAPTION_BOX = { y: BODY_BOX.y + IMAGE_BOX.height + emu(6), height: 457200 };

/** The timeline: a hairline across the body, dots at the stations. */
export const TIMELINE_LINE_Y = BODY_BOX.y + 1943100;
export const TIMELINE_LINE_HEIGHT = emu(2.25);
export const TIMELINE_DOT = 228600;
export const TIMELINE_WHEN_BOX = { y: TIMELINE_LINE_Y - 594360, height: 457200 };
export const TIMELINE_WHAT_BOX = { y: TIMELINE_LINE_Y + 342900, height: 1143000 };

/** Hundredths of a point, which is what `sz` is in. */
export const TITLE_SIZE = centiPoints(DECK.title);
export const COVER_TITLE_SIZE = centiPoints(DECK.coverTitle);
export const SUBTITLE_SIZE = centiPoints(DECK.subtitle);
export const SECTION_TITLE_SIZE = centiPoints(DECK.sectionTitle);
export const ORDINAL_SIZE = centiPoints(DECK.ordinal);
export const CLOSING_TITLE_SIZE = centiPoints(DECK.closingTitle);
export const BODY_SIZE = centiPoints(DECK.body);
export const CODE_SIZE = centiPoints(DECK.code);
/** Headings 3 to 6, which stay in the body rather than opening a slide. */
export const SUBHEADING_SIZES = DECK.subheadings.map(centiPoints);

/** The slide-number box, sitting in the bottom margin. */
export const NUMBER_BOX = { width: emu(48), height: emu(16) };

/** A line of body text, with the leading that goes with it. */
export const LINE_HEIGHT = Math.round(((BODY_SIZE * LEADING.deck.body) / 100) * EMU_PER_POINT);
/** A table row, which is worth one and a half lines of prose. */
export const ROW_HEIGHT = Math.round(LINE_HEIGHT * 1.5);

/**
 * How many body lines a slide holds, and how wide one is in character units.
 *
 * The width is in units of one CJK character at the body size: 852pt of box
 * divided by 18pt a glyph, less a little for the fact that a line ending exactly
 * at the edge wraps. Latin counts as half, which is close enough for prose and
 * is the same approximation `write/table.ts` makes when it shares out columns.
 */
export const BODY_LINES = Math.floor(BODY_BOX.height / LINE_HEIGHT);
/** What fits under a closing slide's centred title. */
export const CLOSING_LINES = Math.floor(CLOSING_BODY_BOX.height / LINE_HEIGHT);
export const COLUMNS = 45;

/** One indent step, as a share of the line — a list level, or a quote's bar. */
export const INDENT_COLUMNS = 2;
export const INDENT_EMU = 274320;

/**
 * Scripts that take a full character width.
 *
 * The same set `write/pdf.ts` breaks lines on, and deliberately a second copy:
 * importing it from there would pull `pdf-lib` and a 2MB font loader into a
 * renderer that embeds nothing.
 */
const WIDE =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦]/;

/** Text width in character units: a wide character is one, everything else is half. */
export function widthOf(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE.test(character) ? 1 : 0.5;
  }
  return width;
}

/** Estimated visual lines, keeping every character and its original run properties. */
export function textLines(piece: Extract<Piece, { kind: "text" }>): Run[][] {
  const columns = Math.max(1, COLUMNS - piece.style.indent * INDENT_COLUMNS);
  const lines: Run[][] = [[]];
  let used = 0;
  for (const run of piece.runs) {
    let fragment = "";
    const append = () => {
      if (fragment) lines[lines.length - 1]!.push({ ...run, text: fragment });
      fragment = "";
    };
    for (const character of run.text) {
      if (character === "\n") {
        fragment += character;
        append();
        lines.push([]);
        used = 0;
        continue;
      }
      const width = widthOf(character);
      if (used + width > columns) {
        append();
        lines.push([]);
        used = 0;
      }
      fragment += character;
      used += width;
    }
    append();
  }
  return lines;
}

/** How many body lines a piece takes, which is the currency slides are filled in. */
export function linesOf(piece: Piece): number {
  if (piece.kind === "table") {
    return Math.ceil(((piece.rows.length + 1) * ROW_HEIGHT) / LINE_HEIGHT);
  }
  return textLines(piece).length + (piece.style.before ? 1 : 0);
}
