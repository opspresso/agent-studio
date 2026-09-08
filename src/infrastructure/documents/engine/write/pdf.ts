/**
 * A document AST to PDF.
 *
 * PDF has no idea what a paragraph is, so unlike the other two renderers this
 * one is a layout engine: it measures, breaks lines, and decides where a page
 * ends. Everything here follows from that.
 *
 * **The Korean font is embedded whole, and that is not optional.** PDF's
 * built-in fonts cover Latin-1 and nothing else, so a document with a single
 * Hangul syllable in it needs a real font in the file. Nanum Gothic ships in
 * this repository (`assets/fonts`, SIL OFL). Noto Sans KR would be the more
 * obvious choice and is not here for a mechanical reason: Google Fonts now
 * publishes it as a variable font, and putting one of those through fontkit is
 * a path with more ways to go wrong than a static TTF has.
 *
 * Whole, rather than subset, because `@pdf-lib/fontkit`'s subsetter **silently
 * drops most Hangul glyphs**. It does not fail: the text layer is intact, so
 * extraction returns the document perfectly, and the page shows blanks where
 * two thirds of the characters should be — "2026년 1분기 보고서" renders as
 * "6년 서". A document that reads correctly to a machine and is unreadable to a
 * person is the worst shape this could take, so the ~750KB a Flate-compressed
 * face costs is paid on every PDF. The bold face is embedded only when
 * something is bold, which is what keeps a plain document to one of them.
 *
 * **Line breaking is per script.** Latin breaks at spaces; CJK breaks between
 * any two characters, because Korean and Chinese prose has no spaces to break
 * at and a line breaker that waits for one produces a single line running off
 * the page. So the text is split into atoms — a word, or one CJK character —
 * and lines are filled greedily.
 *
 * **Italic is synthetic.** Nanum Gothic has no italic face, and shipping a
 * third file to slant some text is not a trade worth making; the text is
 * sheared instead. Bold is a real face, because a faked one is visibly wrong.
 */

import { readFileSync } from "node:fs";
import { MAX_PDF_IMAGE_PIXELS } from "@/domain/llm/imageLimits";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { DocumentError } from "../errors";
import {
  degrees,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFString,
  rgb,
  StandardFonts,
  type RGB,
} from "pdf-lib";
import type { Block, MarkdownDocument, Run } from "../markdown";
import { plainTextOf, withoutDirectives } from "../markdown";
import { columnShares } from "./table";
import {
  HANGUL,
  TOC_THRESHOLD,
  coverOf,
  figureOf,
  tocEntriesOf,
  type Figure,
} from "./semantics";
import {
  DOC,
  LEADING,
  designFor,
  rgbOf,
  type ColourName,
  type DesignProfile,
  type DocumentProfile,
  type Palette,
} from "./theme";
import { PRODUCER } from "../version";
import { imageSize, pdfPngSize, type ImageAsset } from "./image";

/** A4 in points, and a 2cm margin. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56.7;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const BODY_SIZE = DOC.body;
const CODE_SIZE = DOC.code;
const CAPTION_SIZE = DOC.caption;
const HEADING_SIZES = DOC.headings;
/** Space above a heading, as a multiple of its own size. */
const HEADING_SPACE_ABOVE = 0.8;
const PARAGRAPH_SPACE = 6;
const INDENT_STEP = 18;

/** The shared palette, in the three floats `pdf-lib` wants. */
function ink(name: ColourName, palette: Palette): RGB {
  const { r, g, b } = rgbOf(name, palette);
  return rgb(r, g, b);
}

interface PdfColours {
  ink: RGB;
  link: RGB;
  muted: RGB;
  rule: RGB;
  brand: RGB;
  brandLight: RGB;
  tableHeader: RGB;
  tableHeaderText: RGB;
  tint: RGB;
}

function coloursFor(design: DesignProfile): PdfColours {
  const colour = (name: ColourName): RGB => ink(name, design.palette);
  const rgbHex = (hex: string): RGB =>
    rgb(
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    );
  return {
    ink: colour("ink"),
    link: colour("brandDeep"),
    muted: colour("inkMuted"),
    rule: colour("rule"),
    brand: colour("brand"),
    brandLight: colour("brandLight"),
    tableHeader: rgbHex(design.table.headerFill),
    tableHeaderText: rgbHex(design.table.headerText),
    tint: colour("brandTint"),
  };
}

/**
 * Scripts that break between any two characters.
 *
 * Hangul, Han, Kana, and the CJK punctuation and full-width forms that travel
 * with them. A Latin word inside Korean prose is still one atom, which is what
 * keeps `mcp-document` from being broken across two lines.
 */
const CJK =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦]/;

/** Characters the built-in Courier can encode, which is what makes a listing monospaced. */
const LATIN1_ONLY = /^[\x20-\x7e]*$/;

const FONT_DIRECTORY = join(process.cwd(), "assets/document-fonts");

/** Read once per process: two files of about 2MB each. */
let fontBytes: { regular: Uint8Array; bold: Uint8Array } | undefined;

function loadFontBytes(): { regular: Uint8Array; bold: Uint8Array } {
  fontBytes ??= {
    regular: readFileSync(join(FONT_DIRECTORY, "NanumGothic-Regular.ttf")),
    bold: readFileSync(join(FONT_DIRECTORY, "NanumGothic-Bold.ttf")),
  };
  return fontBytes;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

interface EmbeddedFigure {
  image: PDFImage;
  width: number;
  height: number;
}

/** One drawable piece: a word, a run of spaces, or a single CJK character. */
interface Atom {
  text: string;
  run: Run;
  width: number;
  /** A run of spaces, which is dropped when it lands at the end of a line. */
  space: boolean;
}

interface Line {
  atoms: Atom[];
  width: number;
}

function fontFor(fonts: Fonts, run: Run): PDFFont {
  return run.bold ? fonts.bold : fonts.regular;
}

/**
 * `override` exists for text on a brand-filled surface, which has to be white
 * whatever the run says. A link keeps its own colour even there — losing the
 * only signal that it is clickable would be the worse trade.
 */
function colourFor(run: Run, colours: PdfColours, override?: RGB): RGB {
  if (run.href) {
    return override ?? colours.link;
  }
  return override ?? colours.ink;
}

/** Split a run into the smallest pieces a line may break between. */
function atomsOf(run: Run, fonts: Fonts, size: number, maxWidth = Infinity): Atom[] {
  const font = fontFor(fonts, run);
  const atoms: Atom[] = [];
  const push = (text: string, space: boolean): void => {
    if (text !== "") {
      const width = font.widthOfTextAtSize(text, size);
      if (width <= maxWidth) {
        atoms.push({ text, run, width, space });
      } else {
        for (const piece of textSegments(text, font, size, maxWidth)) {
          atoms.push({ text: piece, run, width: font.widthOfTextAtSize(piece, size), space });
        }
      }
    }
  };
  let word = "";
  for (const character of run.text.replace(/\n/g, " ")) {
    if (/\s/.test(character)) {
      push(word, false);
      word = "";
      push(character, true);
      continue;
    }
    if (CJK.test(character)) {
      push(word, false);
      word = "";
      push(character, false);
      continue;
    }
    word += character;
  }
  push(word, false);
  return atoms;
}

/** Greedy fill. A single atom wider than the line gets a line of its own rather than a loop. */
function wrap(atoms: readonly Atom[], maxWidth: number): Line[] {
  const lines: Line[] = [];
  let current: Atom[] = [];
  let width = 0;
  for (const atom of atoms) {
    if (current.length === 0 && atom.space) {
      // A break already happened here; the space that caused it is not indent.
      continue;
    }
    if (width + atom.width > maxWidth && current.length > 0) {
      while (current.length > 0 && current[current.length - 1]!.space) {
        width -= current.pop()!.width;
      }
      lines.push({ atoms: current, width });
      current = atom.space ? [] : [atom];
      width = atom.space ? 0 : atom.width;
      continue;
    }
    current.push(atom);
    width += atom.width;
  }
  if (current.length > 0) {
    lines.push({ atoms: current, width });
  }
  return lines;
}

/** Split overlong text without dropping whitespace or splitting UTF-16 surrogate pairs. */
function textSegments(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const character of text) {
    const next = current + character;
    if (current !== "" && font.widthOfTextAtSize(next, size) > width) {
      lines.push(current);
      current = character;
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines;
}

interface TocEntry {
  text: string;
  level: number;
  page: PDFPage;
}

class Writer {
  private page: PDFPage;
  private y: number;
  private pages = 1;
  /** The blank second page a contents list is drawn onto once the body is laid. */
  private tocPage?: PDFPage;
  /** Level 1-2 headings in body order, with the page each landed on. */
  private readonly headings: TocEntry[] = [];
  private readonly colours: PdfColours;

  constructor(
    private readonly document: PDFDocument,
    private readonly fonts: Fonts,
    private readonly images: ReadonlyMap<string, EmbeddedFigure>,
    private readonly design: DesignProfile = designFor(),
  ) {
    this.colours = coloursFor(design);
    this.page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  pageCount(): number {
    return this.pages;
  }

  /**
   * Page numbers, drawn once the count is known.
   *
   * After the body rather than during it, because a footer written while the
   * page is being filled would be one the layout then has to avoid — and the
   * number of a page is not knowable until the page exists. A single-page
   * document gets none: "1" under a one-page memo is furniture. The cover is
   * counted but not numbered, as every title page is.
   */
  numberPages(skipCover: boolean): void {
    if (this.pages < 2) {
      return;
    }
    for (const [index, page] of this.document.getPages().entries()) {
      if (skipCover && index === 0) {
        continue;
      }
      const label = `${index + 1}`;
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - this.fonts.regular.widthOfTextAtSize(label, CAPTION_SIZE),
        // Inside the bottom margin, which nothing else is allowed to enter.
        y: MARGIN * 0.55,
        size: CAPTION_SIZE,
        font: this.fonts.regular,
        color: this.colours.muted,
      });
    }
  }

  newPage(): void {
    this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages += 1;
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /**
   * The cover: the brand rule a third down the page, the title under it in the
   * cover size, the subtitle in the muted ink. The caller turns the page — the
   * cover does not know whether a contents page follows it.
   */
  cover(title: readonly Run[], subtitle: readonly Run[] | undefined): void {
    this.y = PAGE_HEIGHT - 280;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y,
      width: this.design.doc.coverRulePoints,
      height: 3,
      color: this.colours.brand,
    });
    this.y -= 20;
    this.paragraph(
      title.map((run) => ({ ...run, bold: true })),
      {
        size: DOC.coverTitle,
        left: MARGIN,
        width: CONTENT_WIDTH,
        leading: LEADING.document.coverTitle,
      },
    );
    if (subtitle) {
      this.space(10);
      this.paragraph(subtitle, {
        size: DOC.subtitle,
        left: MARGIN,
        width: CONTENT_WIDTH,
        colour: this.colours.muted,
        leading: LEADING.document.subtitle,
      });
    }
  }

  /** The blank page the contents will occupy, claimed before the body decides them. */
  reserveTocPage(): void {
    this.tocPage = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages += 1;
  }

  /**
   * What stands at the top of a chapter's page: its number, large and in the
   * light brand. A fresh page first, except when nothing is on this one.
   */
  chapterOpener(ordinal: number): void {
    if (this.y < PAGE_HEIGHT - MARGIN) {
      this.newPage();
    }
    const height = DOC.ordinal * 1.05;
    this.reserve(height);
    this.page.drawText(String(ordinal).padStart(2, "0"), {
      x: MARGIN,
      y: this.y,
      size: DOC.ordinal,
      font: this.fonts.bold,
      color: this.colours.brandLight,
    });
  }

  /** Lay out every contents entry before inserting pages and resolving page references. */
  fillToc(label: string): void {
    if (!this.tocPage) {
      return;
    }
    const labelSize = HEADING_SIZES[0]!;
    const top = PAGE_HEIGHT - MARGIN - labelSize * LEADING.document.heading - 14;
    const height = BODY_SIZE * 1.7;
    const capacity = Math.max(1, Math.floor((top - MARGIN) / height));
    type TocLine = { line: Line; entry: TocEntry; first: boolean };
    const groups: TocLine[][] = [[]];
    for (const entry of this.headings) {
      const indent = (entry.level - 1) * INDENT_STEP;
      const run = { text: entry.text, bold: entry.level === 1 };
      const width = CONTENT_WIDTH - indent - 60;
      const lines = wrap(atomsOf(run, this.fonts, BODY_SIZE, width), width);
      let group = groups[groups.length - 1]!;
      if (lines.length <= capacity && group.length + lines.length > capacity) {
        group = [];
        groups.push(group);
      }
      lines.forEach((line, index) => {
        if (group.length === capacity) {
          group = [];
          groups.push(group);
        }
        group.push({ line, entry, first: index === 0 });
      });
    }
    const tocIndex = this.document.getPages().indexOf(this.tocPage);
    const pages = [this.tocPage];
    for (let index = 1; index < groups.length; index += 1) {
      pages.push(this.document.insertPage(tocIndex + index, [PAGE_WIDTH, PAGE_HEIGHT]));
      this.pages += 1;
    }
    const pageNumbers = new Map(this.document.getPages().map((page, index) => [page, index + 1]));
    const saved = { page: this.page, y: this.y };
    groups.forEach((group, index) => {
      this.page = pages[index]!;
      this.y = top;
      this.page.drawText(label, {
        x: MARGIN, y: top + 14 + labelSize * 0.3, size: labelSize,
        font: this.fonts.bold, color: this.colours.brand,
      });
      this.page.drawLine({
        start: { x: MARGIN, y: top + 10 },
        end: { x: PAGE_WIDTH - MARGIN, y: top + 10 },
        thickness: 0.75, color: this.colours.brandLight,
      });
      for (const { line, entry, first } of group) {
        this.y -= height;
        const baseline = this.y + height * 0.25;
        this.drawLine(line, MARGIN + (entry.level - 1) * INDENT_STEP, BODY_SIZE, baseline,
          entry.level === 1 ? this.colours.ink : this.colours.muted);
        if (first) {
          const number = String(pageNumbers.get(entry.page));
          this.page.drawText(number, {
            x: PAGE_WIDTH - MARGIN - this.fonts.regular.widthOfTextAtSize(number, BODY_SIZE),
            y: baseline, size: BODY_SIZE, font: this.fonts.regular, color: this.colours.muted,
          });
        }
      }
    });
    this.page = saved.page;
    this.y = saved.y;
  }

  /** Make room for `height`, starting a page when there is none. */
  private reserve(height: number): void {
    if (this.y - height < MARGIN) {
      this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.pages += 1;
      this.y = PAGE_HEIGHT - MARGIN;
    }
    this.y -= height;
  }

  private space(height: number): void {
    // Never at the top of a page: leading whitespace there is a margin nobody
    // asked for, and it accumulates every time a block starts a page.
    if (this.y < PAGE_HEIGHT - MARGIN) {
      this.y -= height;
    }
  }

  /**
   * A clickable region over text already drawn.
   *
   * The annotation is what makes a link a link — colouring text blue only makes
   * it look like one, and a reader who clicks gets nothing.
   */
  private annotate(href: string, x: number, y: number, width: number, height: number): void {
    const annotation = this.document.context.register(
      this.document.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [x, y, x + width, y + height],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of(href) },
      }),
    );
    const existing = this.page.node.lookup(PDFName.of("Annots"));
    if (existing && "push" in existing && typeof existing.push === "function") {
      (existing as { push: (value: unknown) => void }).push(annotation);
      return;
    }
    this.page.node.set(PDFName.of("Annots"), this.document.context.obj([annotation]));
  }

  private drawLine(
    line: Line,
    left: number,
    size: number,
    baseline: number,
    colour?: RGB,
  ): void {
    let x = left;
    /** Where the current link started, so it is underlined and annotated once. */
    let linkFrom: number | undefined;
    let linkHref: string | undefined;

    const closeLink = (to: number): void => {
      if (linkFrom === undefined || linkHref === undefined) {
        return;
      }
      // One rectangle for the whole link, not one per word: two annotations
      // with the space between them left out is a link with a dead gap in it.
      this.page.drawLine({
        start: { x: linkFrom, y: baseline - size * 0.12 },
        end: { x: to, y: baseline - size * 0.12 },
        thickness: 0.5,
        color: this.colours.link,
      });
      this.annotate(linkHref, linkFrom, baseline - size * 0.2, to - linkFrom, size);
      linkFrom = undefined;
      linkHref = undefined;
    };

    for (const atom of line.atoms) {
      if (atom.run.href !== linkHref) {
        closeLink(x);
        if (atom.run.href) {
          linkFrom = x;
          linkHref = atom.run.href;
        }
      }
      if (!atom.space) {
        this.page.drawText(atom.text, {
          x,
          y: baseline,
          size,
          font: fontFor(this.fonts, atom.run),
          color: colourFor(atom.run, this.colours, colour),
          // Nanum Gothic has no italic face; shearing the glyphs is what stands
          // in for one.
          ...(atom.run.italic ? { xSkew: degrees(12) } : {}),
        });
      }
      x += atom.width;
    }
    closeLink(x);
  }

  /** Lay out runs into the given width and draw them, returning the height used. */
  private paragraph(
    runs: readonly Run[],
    options: {
      size: number;
      left: number;
      width: number;
      firstLinePrefix?: Atom[];
      colour?: RGB;
      leading?: number;
    },
  ): PDFPage {
    const { size, left, width } = options;
    const atoms = [
      ...(options.firstLinePrefix ?? []),
      ...runs.flatMap((run) => atomsOf(run, this.fonts, size, width)),
    ];
    const lines = wrap(atoms, width);
    const height = size * (options.leading ?? LEADING.document.body);
    let firstPage: PDFPage | undefined;
    for (const line of lines.length > 0 ? lines : [{ atoms: [], width: 0 }]) {
      this.reserve(height);
      firstPage ??= this.page;
      // The baseline sits above the descender, not on the line's bottom edge.
      this.drawLine(line, left, size, this.y + height * 0.25, options.colour);
    }
    return firstPage!;
  }

  private codeBlock(text: string): void {
    const lines = text === "" ? [""] : text.split("\n");
    // One decision for the whole block: a listing whose lines changed font
    // halfway down reads as a rendering fault rather than as a choice.
    const monospaced = lines.every((line) => LATIN1_ONLY.test(line));
    const font = monospaced ? this.fonts.mono : this.fonts.regular;
    const height = CODE_SIZE * LEADING.document.compact;
    this.space(PARAGRAPH_SPACE);
    for (const line of lines.flatMap((line) => textSegments(line, font, CODE_SIZE, CONTENT_WIDTH - 12))) {
      this.reserve(height);
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y,
        width: CONTENT_WIDTH,
        height,
        color: this.colours.tint,
      });
      this.page.drawText(line, {
        x: MARGIN + 6,
        y: this.y + height * 0.28,
        size: CODE_SIZE,
        font,
        color: this.colours.ink,
      });
    }
    this.space(PARAGRAPH_SPACE);
  }

  private table(block: Extract<Block, { kind: "table" }>): void {
    const rows = [block.header, ...block.rows];
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const widths = columnWidths(rows, columns);
    const lineHeight = BODY_SIZE * LEADING.document.compact;
    const pageHeight = PAGE_HEIGHT - 2 * MARGIN;
    const layout = (cells: Run[][], header: boolean): Line[][] =>
      Array.from({ length: columns }, (_, column) => {
        const runs = (cells[column] ?? []).map((run) => (header ? { ...run, bold: true } : run));
        return wrap(
          runs.flatMap((run) => atomsOf(run, this.fonts, BODY_SIZE, widths[column]! - 10)),
          widths[column]! - 10,
        );
      });
    const lineCount = (laid: Line[][]): number => Math.max(1, ...laid.map((lines) => lines.length));
    const headerLines = layout(block.header, true);
    const headerCount = lineCount(headerLines);
    const headerHeight = headerCount * lineHeight + 6;
    // A header taller than a page is rendered in full once, across pages.
    const repeatHeader = headerHeight + lineHeight + 6 <= pageHeight;
    const draw = (laid: Line[][], index: number, offset: number, count: number): void => {
      const header = index === 0;
      const height = count * lineHeight + 6;
      this.reserve(height);
      // One fill per row, not one box per cell. A full grid boxes every number
      // in; the eye reads a table by its rows, and the column gaps are already
      // doing what the vertical lines would.
      const fill = header
        ? this.colours.tableHeader
        : index % 2 === 0
          ? this.colours.tint
          : undefined;
      if (fill) {
        this.page.drawRectangle({
          x: MARGIN,
          y: this.y,
          width: CONTENT_WIDTH,
          height,
          color: fill,
        });
      }
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
        thickness: 0.5,
        color: this.colours.rule,
      });
      let x = MARGIN;
      laid.forEach((lines, column) => {
        const width = widths[column]!;
        const align = block.align[column];
        lines.slice(offset, offset + count).forEach((line, lineIndex) => {
          // Every line of a wrapped cell is placed on its own, so a two-line
          // right-aligned cell has both lines flush to the same edge.
          const left =
            align === "right"
              ? x + width - 5 - line.width
              : align === "center"
                ? x + (width - line.width) / 2
                : x + 5;
          this.drawLine(
            line,
            left,
            BODY_SIZE,
            this.y + height - 4 - (lineIndex + 1) * lineHeight + BODY_SIZE * 0.35,
            header ? this.colours.tableHeaderText : undefined,
          );
        });
        x += width;
      });
    };
    const nextPage = (index: number): void => {
      this.newPage();
      if (index > 0 && repeatHeader) draw(headerLines, 0, 0, headerCount);
    };
    this.space(PARAGRAPH_SPACE);
    rows.forEach((cells, index) => {
      const laid = index === 0 ? headerLines : layout(cells, false);
      const count = lineCount(laid);
      const height = count * lineHeight + 6;
      const freshRoom = pageHeight - (index > 0 && repeatHeader ? headerHeight : 0);
      if (height <= freshRoom && height > this.y - MARGIN) nextPage(index);
      let offset = 0;
      while (offset < count) {
        const room = Math.floor((this.y - MARGIN - 6) / lineHeight);
        if (room < 1) {
          nextPage(index);
          continue;
        }
        const take = Math.min(room, count - offset);
        draw(laid, index, offset, take);
        offset += take;
        if (offset < count) nextPage(index);
      }
    });
    this.space(PARAGRAPH_SPACE);
  }

  private figure(figure: Figure): void {
    const embedded = this.images.get(figure.asset);
    if (!embedded) {
      throw new DocumentError(
        `the document references asset://${figure.asset} but no asset of that name was provided`,
      );
    }
    const natural = { width: embedded.width * 0.75, height: embedded.height * 0.75 };
    const scale = Math.min(1, CONTENT_WIDTH / natural.width, 430 / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    const captionLines = wrap(
      figure.caption.flatMap((run) => atomsOf(run, this.fonts, CAPTION_SIZE, CONTENT_WIDTH)),
      CONTENT_WIDTH,
    );
    const lineHeight = CAPTION_SIZE * LEADING.document.compact;
    const captionHeight = captionLines.length * lineHeight;
    const gap = captionHeight > 0 ? 8 : 0;

    this.space(PARAGRAPH_SPACE);
    this.reserve(height + gap + captionHeight);
    this.page.drawImage(embedded.image, {
      x: MARGIN + (CONTENT_WIDTH - width) / 2,
      y: this.y + captionHeight + gap,
      width,
      height,
    });
    captionLines.forEach((line, index) => {
      this.drawLine(
        line,
        MARGIN + (CONTENT_WIDTH - line.width) / 2,
        CAPTION_SIZE,
        this.y + captionHeight - (index + 1) * lineHeight + lineHeight * 0.25,
        this.colours.muted,
      );
    });
    this.space(PARAGRAPH_SPACE);
  }

  block(block: Block): void {
    switch (block.kind) {
      case "heading": {
        const size = HEADING_SIZES[block.level - 1]!;
        this.space(size * HEADING_SPACE_ABOVE);
        const firstPage = this.paragraph(
          block.runs.map((run) => ({ ...run, bold: true })),
          {
            size,
            left: MARGIN,
            width: CONTENT_WIDTH,
            colour: this.colours.brand,
            leading: LEADING.document.heading,
          },
        );
        // Recorded after the draw, when the page it landed on is a fact.
        if (block.level <= 2) {
          this.headings.push({
            text: plainTextOf(block.runs),
            level: block.level,
            page: firstPage,
          });
        }
        // A hairline under the top two levels, in the brand colour. It is what
        // a full-bleed tint would cost on paper: the same signal at a
        // hundredth of the ink.
        if (block.level <= 2) {
          this.space(3);
          this.reserve(1);
          this.page.drawLine({
            start: { x: MARGIN, y: this.y },
            end: { x: PAGE_WIDTH - MARGIN, y: this.y },
            thickness: 0.75,
            color: this.colours.brandLight,
          });
        }
        this.space(2);
        return;
      }
      case "paragraph":
        if (figureOf(block)) {
          this.figure(figureOf(block)!);
          return;
        }
        this.paragraph(block.runs, { size: BODY_SIZE, left: MARGIN, width: CONTENT_WIDTH });
        this.space(PARAGRAPH_SPACE);
        return;
      case "list": {
        const counters: number[] = [];
        for (const item of block.items) {
          counters.length = item.depth + 1;
          counters[item.depth] = (counters[item.depth] ?? 0) + 1;
          const marker = block.ordered ? `${counters[item.depth]}.  ` : "•  ";
          const left = MARGIN + INDENT_STEP * item.depth;
          const prefix = atomsOf({ text: marker }, this.fonts, BODY_SIZE);
          this.paragraph(item.runs, {
            size: BODY_SIZE,
            left,
            width: CONTENT_WIDTH - INDENT_STEP * item.depth,
            firstLinePrefix: prefix,
          });
        }
        this.space(PARAGRAPH_SPACE);
        return;
      }
      case "code":
        this.codeBlock(block.text);
        return;
      case "quote": {
        this.space(PARAGRAPH_SPACE / 2);
        const top = this.y;
        this.paragraph(
          block.runs.map((run) => ({ ...run, italic: true })),
          {
            size: BODY_SIZE,
            left: MARGIN + INDENT_STEP,
            width: CONTENT_WIDTH - INDENT_STEP,
            colour: this.colours.muted,
          },
        );
        // Only when the quote stayed on one page: a bar drawn from a `top` that
        // belongs to the previous page runs the length of this one.
        if (this.y < top) {
          this.page.drawRectangle({
            x: MARGIN,
            y: this.y,
            width: 2,
            height: top - this.y,
            color: this.colours.brandLight,
          });
        }
        this.space(PARAGRAPH_SPACE);
        return;
      }
      case "table":
        this.table(block);
        return;
      case "rule":
        this.space(PARAGRAPH_SPACE);
        this.reserve(1);
        this.page.drawLine({
          start: { x: MARGIN, y: this.y },
          end: { x: PAGE_WIDTH - MARGIN, y: this.y },
          thickness: 0.5,
          color: this.colours.rule,
        });
        this.space(PARAGRAPH_SPACE);
        return;
      case "directive":
        // A directive is a PPTX planning hint; on a page its contents stand
        // where it stood.
        for (const inner of block.blocks) {
          this.block(inner);
        }
        return;
    }
  }
}

/** The shared column shares, in points. */
export function columnWidths(rows: readonly Run[][][], columns: number): number[] {
  return columnShares(rows, columns).map((share) => share * CONTENT_WIDTH);
}

export interface PdfOptions {
  title: string;
  /** Passed in rather than read from the clock, so the bytes follow from the input. */
  created: Date;
  profile?: DocumentProfile;
  /** Keyed by the name `asset://name` references. */
  assets?: Record<string, ImageAsset>;
}

export interface RenderedPdf {
  bytes: Uint8Array;
  pages: number;
}

/**
 * Whether anything in the document is set in bold.
 *
 * Asked so the bold face can be left out when it is not used, which halves the
 * font weight of a plain document. Headings and table headers are bolded by
 * this renderer rather than by the parser, so they count here even though no
 * run in them says so.
 *
 * **Over the blocks the renderer draws, not the ones the parser returned.** A
 * `:::cards` fence has no treatment on a page, so `block()` renders its
 * contents where the fence stood — and this walk did not look inside one. A
 * document whose headings or `**bold**` all sat in a directive answered `false`
 * here, so no bold face was embedded, `fontFor` fell back to the regular one,
 * and every heading in the file came out at body weight. Nothing errors and the
 * text extracts perfectly; it is only wrong to look at.
 */
export function usesBold(document: MarkdownDocument): boolean {
  return withoutDirectives(document).blocks.some(
    (block) =>
      block.kind === "heading" ||
      block.kind === "table" ||
      (block.kind === "paragraph" && block.runs.some((run) => run.bold)) ||
      (block.kind === "quote" && block.runs.some((run) => run.bold)) ||
      (block.kind === "list" && block.items.some((item) => item.runs.some((run) => run.bold))),
  );
}

function figureAssets(blocks: readonly Block[]): Set<string> {
  const names = new Set<string>();
  for (const block of blocks) {
    const figure = figureOf(block);
    if (figure) {
      names.add(figure.asset);
    }
    if (block.kind === "directive") {
      for (const name of figureAssets(block.blocks)) {
        names.add(name);
      }
    }
  }
  return names;
}

export async function renderPdf(
  document: MarkdownDocument,
  options: PdfOptions,
): Promise<RenderedPdf> {
  let decodedPixels = 0;
  const figures = [...figureAssets(document.blocks)].map((name) => {
    const asset = options.assets && Object.hasOwn(options.assets, name) ? options.assets[name] : undefined;
    if (!asset) throw new DocumentError(`the document references asset://${name} but no asset of that name was provided`);
    const size = asset.mimeType === "image/png" ? pdfPngSize(asset.bytes) : imageSize(asset.bytes, asset.mimeType);
    // PNG embedding decodes raster buffers outside V8's old-space heap limit.
    if (asset.mimeType === "image/png") decodedPixels += size.width * size.height;
    if (decodedPixels > MAX_PDF_IMAGE_PIXELS) throw new DocumentError(`PDF image assets exceed ${MAX_PDF_IMAGE_PIXELS} decoded PNG pixels`);
    return { name, asset, size };
  });
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const bytes = loadFontBytes();
  // `subset: true` is what one would want and is not usable: it drops most
  // Hangul glyphs without erroring. See the note at the top of this file.
  const regular = await pdf.embedFont(bytes.regular, { subset: false });
  const fonts: Fonts = {
    regular,
    bold: usesBold(document) ? await pdf.embedFont(bytes.bold, { subset: false }) : regular,
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const images = new Map<string, EmbeddedFigure>();
  for (const { name, asset, size } of figures) {
    const image =
      asset.mimeType === "image/png"
        ? await pdf.embedPng(asset.bytes)
        : await pdf.embedJpg(asset.bytes);
    images.set(name, { image, width: size.width, height: size.height });
  }
  pdf.setTitle(options.title);
  // Both fields, because readers disagree about which one they show: Preview
  // reads `Creator`, most others `Producer`.
  pdf.setProducer(PRODUCER);
  pdf.setCreator(PRODUCER);
  pdf.setCreationDate(options.created);
  pdf.setModificationDate(options.created);

  const { cover, body } = coverOf(document.blocks);
  const toc = cover !== undefined && tocEntriesOf(body).length >= TOC_THRESHOLD;

  const writer = new Writer(pdf, fonts, images, designFor(options.profile));
  if (cover) {
    writer.cover(cover.title, cover.subtitle);
    if (toc) {
      writer.reserveTocPage();
    }
    if (body.length > 0) {
      writer.newPage();
    }
  }
  let ordinal = 0;
  for (const block of body) {
    if (block.kind === "heading" && block.level === 1) {
      ordinal += 1;
      writer.chapterOpener(ordinal);
    }
    writer.block(block);
  }
  if (toc && cover) {
    writer.fillToc(HANGUL.test(plainTextOf(cover.title)) ? "목차" : "Contents");
  }
  writer.numberPages(cover !== undefined);
  return { bytes: await pdf.save(), pages: writer.pageCount() };
}
