/**
 * A planned slide to its XML part.
 *
 * Everything here is shape arithmetic: the planner has already decided what is
 * on the slide, and this module decides what DrawingML says it. Runs of text
 * sit in one box; a table is a frame of its own, so a body is stacked rather
 * than being a single shape.
 *
 * What is *not* here is decoration. The cover's ground and band, the section
 * slide's brand field, the content footer — those live on the slide layouts in
 * `package.ts`, which is where PowerPoint itself keeps a template's design.
 * A slide carries its content and nothing else, which is what lets a reader
 * edit the deck without stepping around furniture, and keeps the decoration
 * out of every text extractor's way.
 */

import { escapeXml } from "../../xml";
import type { Run } from "../../markdown";
import { columnShares } from "../table";
import {
  DECK,
  LEADING,
  TYPOGRAPHY,
  centiPoints,
  designFor,
  type DesignProfile,
  type Palette,
} from "../theme";
import {
  ATTRIBUTION_BOX,
  BODY_BOX,
  BODY_SIZE,
  CARD_HEIGHT,
  CARD_INSET,
  CARD_TOP,
  CHIP_HEIGHT,
  CLOSING_BODY_BOX,
  CLOSING_TITLE_BOX,
  CLOSING_TITLE_SIZE,
  COMPARE_BODY_TOP,
  COMPARE_GAP,
  CONTENT_WIDTH,
  COVER_TITLE_BOX,
  COVER_TITLE_SIZE,
  GRID_GAP,
  IMAGE_BOX,
  IMAGE_CAPTION_BOX,
  INDENT_EMU,
  LINE_HEIGHT,
  METRIC_LABEL_BOX,
  METRIC_VALUE_BOX,
  NUMBER_BOX,
  ORDINAL_SIZE,
  PROCESS_ARROW,
  PROCESS_GAP,
  PROCESS_NODE_HEIGHT,
  PROCESS_NODE_TOP,
  QUOTE_BAR_WIDTH,
  QUOTE_BOX,
  QUOTE_INDENT,
  ROW_HEIGHT,
  SECTION_ORDINAL_BOX,
  SECTION_TITLE_BOX,
  SECTION_TITLE_SIZE,
  SIDE_MARGIN,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  SUBTITLE_BOX,
  SUBTITLE_SIZE,
  TIMELINE_DOT,
  TIMELINE_LINE_HEIGHT,
  TIMELINE_LINE_Y,
  TIMELINE_WHAT_BOX,
  TIMELINE_WHEN_BOX,
  TITLE_BOX,
  TITLE_SIZE,
  linesOf,
} from "./layout";
import { A, NUMBER_FIELD_ID, P, R, TABLE_STYLE_ID } from "./ooxml";
import { fitInto, type ImageSize } from "../image";
import { HANGUL } from "../semantics";
import type { Piece, Slide, Style } from "./types";

/** What a slide's rels part needs to say about one relationship, in rId order. */
export interface SlideRelationship {
  kind: "hyperlink" | "image";
  target: string;
}

/** Where a named asset's bytes ended up, and how big the picture is. */
export interface MediaEntry {
  file: string;
  size: ImageSize;
}

const BODY_STYLE: Style = { size: BODY_SIZE, indent: 0 };

/** How transparent a divider's ordinal is: present, but a mark rather than text. */
const ORDINAL_ALPHA = 45000;

const CARD_TITLE_SIZE = centiPoints(DECK.cardTitle);
const CARD_BODY_SIZE = centiPoints(DECK.cardBody);
const METRIC_SIZE = centiPoints(DECK.metric);
const METRIC_LABEL_SIZE = centiPoints(DECK.metricLabel);
const QUOTE_SIZE = centiPoints(DECK.quote);

/** A chip is a pill: the radius maxes out at half the height. */
const CHIP_RADIUS = 50000;

// No face is ever named for prose, so the run's language is the one signal
// PowerPoint has for choosing its east-Asian default — a run of 한글 labelled
// `en-US` is rendered through whatever CJK face the *reader's locale* prefers,
// which on a Japanese or English machine is not a Korean one.

/** `sz` and the rest of `a:rPr`, for one run inside a paragraph of a given style. */
function runProperties(run: Run, style: Style, palette: Palette, linkId?: string): string {
  const bold = run.bold || style.bold;
  const italic = run.italic || style.italic;
  const mono = run.code || style.mono;
  const colour = run.href ? palette.brandDeep : (style.colour ?? palette.ink);
  const lang = HANGUL.test(run.text) ? "ko-KR" : "en-US";
  const fill = style.alpha
    ? `<a:srgbClr val="${colour}"><a:alpha val="${style.alpha}"/></a:srgbClr>`
    : `<a:srgbClr val="${colour}"/>`;
  return (
    `<a:rPr lang="${lang}" sz="${style.size}" kern="${centiPoints(TYPOGRAPHY.kerningFromPoints)}" ` +
    `spc="${TYPOGRAPHY.tracking}"${bold ? ' b="1"' : ""}${italic ? ' i="1"' : ""}` +
    `${run.href ? ' u="sng"' : ""} dirty="0">` +
    `<a:solidFill>${fill}</a:solidFill>` +
    // Only the Latin face is named, and only for code. Naming a face for prose
    // is what `write/docx.ts` refuses to do for the same reason: a font chosen
    // here is a font the reader's machine may not have, and the substitute is
    // then chosen by nobody.
    (mono ? '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>' : "") +
    (linkId ? `<a:hlinkClick xmlns:r="${R}" r:id="${linkId}"/>` : "") +
    "</a:rPr>"
  );
}

/** `a:t`, with a newline inside a run becoming the break it was. */
function runElement(run: Run, style: Style, palette: Palette, linkId?: string): string {
  return run.text
    .split("\n")
    .map((line) => `<a:r>${runProperties(run, style, palette, linkId)}<a:t>${escapeXml(line)}</a:t></a:r>`)
    .join(`<a:br>${runProperties(run, style, palette, linkId)}</a:br>`);
}

export class Renderer {
  /** Relationships for the slide being written — links and pictures, in rId order. */
  private rels: SlideRelationship[] = [];
  /** Shape ids are unique within a slide's tree; 1 is the tree itself. */
  private nextId = 2;

  /**
   * Where each named asset's media part lives. The map is the whole deck's,
   * built by `index.ts` before any slide renders, so two slides showing the
   * same picture share one part.
   */
  constructor(
    private readonly media: ReadonlyMap<string, MediaEntry> = new Map(),
    private readonly design: DesignProfile = designFor(),
  ) {}

  /** Start a slide, discarding the previous one's relationships and ids. */
  private reset(): void {
    this.rels = [];
    this.nextId = 2;
  }

  /** rId1 is the layout, so everything else starts above it. */
  private relationshipFor(kind: SlideRelationship["kind"], target: string): string {
    let index = this.rels.findIndex((rel) => rel.kind === kind && rel.target === target);
    if (index === -1) {
      index = this.rels.push({ kind, target }) - 1;
    }
    return `rId${index + 2}`;
  }

  private paragraph(runs: readonly Run[], style: Style): string {
    const marginLeft = style.indent * INDENT_EMU;
    const algn = style.align === "right" ? "r" : style.align === "center" ? "ctr" : "l";
    const leading = Math.round((style.leading ?? LEADING.deck.body) * 100000);
    const properties =
      `<a:pPr marL="${marginLeft}" indent="0" algn="${algn}">` +
      `<a:lnSpc><a:spcPct val="${leading}"/></a:lnSpc>` +
      (style.before ? `<a:spcBef><a:spcPts val="${style.before}"/></a:spcBef>` : "") +
      // Every list marker here is literal text, as in the other three renderers,
      // so PowerPoint's own bullet has to be turned off or every line gets two.
      "<a:buNone/></a:pPr>";
    const body =
      runs.length === 0
        ? `<a:endParaRPr lang="en-US" sz="${style.size}"/>`
        : runs
            .map((run, index) =>
              runElement(
                run,
                // The first run is the marker when the style says so — the one
                // drop of brand a content line carries.
                index === 0 && style.marker ? { ...style, colour: style.marker } : style,
                this.design.palette,
                run.href ? this.relationshipFor("hyperlink", run.href) : undefined,
              ),
            )
            .join("");
    return `<a:p>${properties}${body}</a:p>`;
  }

  /** A text box, positioned absolutely. `placeholder` fills the layout's slot. */
  private textShape(
    name: string,
    box: { x: number; y: number; width: number; height: number },
    paragraphs: string,
    placeholder?: string,
  ): string {
    const id = this.nextId;
    this.nextId += 1;
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
      `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
      `<p:nvPr>${placeholder ?? ""}</p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
      `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      // No insets, so the box the text is laid out in is the box measured above.
      // `normAutofit` is the safety net for an estimate that came out short.
      '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0">' +
      "<a:normAutofit/></a:bodyPr><a:lstStyle/>" +
      paragraphs +
      "</p:txBody></p:sp>"
    );
  }

  private table(piece: Extract<Piece, { kind: "table" }>, y: number): string {
    const rows = [piece.header, ...piece.rows];
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const widths = columnShares(rows, columns).map((share) => Math.round(share * CONTENT_WIDTH));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const id = this.nextId;
    this.nextId += 1;

    // Horizontal rules only. A full grid boxes every number in, and the eye
    // reads a table by its rows — the column gaps do what the vertical lines
    // would have.
    const border = (edge: string): string =>
      `<a:${edge} w="12700" cap="flat" cmpd="sng" algn="ctr">` +
      `<a:solidFill><a:srgbClr val="${this.design.palette.rule}"/></a:solidFill>` +
      `<a:prstDash val="solid"/></a:${edge}>`;
    const noBorder = (edge: string): string => `<a:${edge}><a:noFill/></a:${edge}>`;
    const cell = (cells: readonly Run[][], column: number, row: number): string => {
      const header = row === 0;
      const runs = cells[column] ?? [];
      // Zebra counted from the header, so the first data row is the plain one.
      const fill = header
        ? this.design.table.headerFill
        : row % 2 === 0
          ? this.design.palette.brandTint
          : undefined;
      // A cell with no paragraph in it is what makes PowerPoint call the file
      // corrupt — the same trap `w:tc` has in DOCX.
      return (
        "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>" +
        this.paragraph(runs, {
          ...BODY_STYLE,
          align: piece.align[column],
          ...(header ? { bold: true, colour: this.design.table.headerText } : {}),
        }) +
        "</a:txBody>" +
        '<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">' +
        noBorder("lnL") +
        noBorder("lnR") +
        border("lnT") +
        border("lnB") +
        (fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "") +
        "</a:tcPr></a:tc>"
      );
    };

    const body = rows
      .map(
        (cells, index) =>
          `<a:tr h="${ROW_HEIGHT}">` +
          Array.from({ length: columns }, (_, column) => cell(cells, column, index)).join("") +
          "</a:tr>",
      )
      .join("");

    return (
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
      '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>' +
      "<p:nvPr/></p:nvGraphicFramePr>" +
      `<p:xfrm><a:off x="${SIDE_MARGIN}" y="${y}"/>` +
      `<a:ext cx="${total}" cy="${ROW_HEIGHT * rows.length}"/></p:xfrm>` +
      // The literal URI, not `${A}/table`: the table's graphicData URI is
      // `.../drawingml/2006/table` — the namespace with `main` swapped out, not
      // appended to. PowerPoint identifies the embedded object by this string
      // alone, and an unknown URI is not "a table it renders differently", it is
      // damage: the repair flow throws away the whole slide's content. No schema
      // catches it, because to a schema a URI is just a token.
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
      // The style id resolves against `tableStyles.xml`; every visible border
      // is still stated per cell, so the style only supplies what native files
      // always carry.
      `<a:tblPr firstRow="1"><a:tableStyleId>${TABLE_STYLE_ID}</a:tableStyleId></a:tblPr>` +
      `<a:tblGrid>${widths.map((width) => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>` +
      body +
      "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>"
    );
  }

  /**
   * The slide number, bottom right.
   *
   * A `slidenum` field rather than a digit, so a deck that gets a slide inserted
   * renumbers itself. It carries **no `a:t`** — the element is optional, and the
   * literal it would hold is what every text extractor picks up: this server's
   * own reader would then return "7" as a line of the slide's content. The empty
   * paragraph it leaves behind lands at the end of the slide, where `normalize`
   * drops it.
   */
  private slideNumber(ordinal: number, colour: string): string {
    const id = this.nextId;
    this.nextId += 1;
    const box = {
      x: SLIDE_WIDTH - SIDE_MARGIN - NUMBER_BOX.width,
      y: SLIDE_HEIGHT - SIDE_MARGIN,
      width: NUMBER_BOX.width,
      height: NUMBER_BOX.height,
    };
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Number"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
      `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>' +
      '<a:p><a:pPr algn="r"/>' +
      `<a:fld id="${NUMBER_FIELD_ID}" type="slidenum">` +
      `<a:rPr lang="en-US" sz="${centiPoints(DECK.caption)}">` +
      `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:rPr>` +
      // The cached text every native fld carries. PowerPoint recomputes it on
      // open; the reader skips fld contents, so it never reaches extraction.
      `<a:t>${ordinal}</a:t>` +
      "</a:fld></a:p></p:txBody></p:sp>"
    );
  }

  /** Pieces stacked into shapes from `startY` down. Text shares boxes; tables get frames. */
  private stack(
    shapes: string[],
    pieces: readonly Piece[],
    startY: number,
    restyle?: (style: Style) => Style,
  ): void {
    let y = startY;
    let paragraphs: string[] = [];
    let lines = 0;
    /** The first text box claims the layout's body placeholder; later ones cannot. */
    let placeholderUsed = false;

    const flushText = (): void => {
      if (paragraphs.length === 0) {
        return;
      }
      const height = Math.max(LINE_HEIGHT, lines * LINE_HEIGHT);
      shapes.push(
        this.textShape(
          `Body ${shapes.length + 1}`,
          { x: SIDE_MARGIN, y, width: CONTENT_WIDTH, height },
          paragraphs.join(""),
          placeholderUsed ? undefined : '<p:ph type="body" idx="1"/>',
        ),
      );
      placeholderUsed = true;
      y += height;
      paragraphs = [];
      lines = 0;
    };

    for (const piece of pieces) {
      if (piece.kind === "table") {
        flushText();
        shapes.push(this.table(piece, y));
        y += linesOf(piece) * LINE_HEIGHT;
        continue;
      }
      paragraphs.push(this.paragraph(piece.runs, restyle ? restyle(piece.style) : piece.style));
      lines += linesOf(piece);
    }
    flushText();
  }

  /**
   * A rounded rectangle that carries its own text — a card, a chip.
   *
   * One native shape, not a rectangle with a text box over it: what the reader
   * selects in PowerPoint is the card, and dragging it takes the words along.
   */
  private roundedShape(
    name: string,
    box: { x: number; y: number; width: number; height: number },
    fill: string,
    radius: number,
    paragraphs: string,
    options?: { inset?: number; anchor?: "t" | "ctr" },
  ): string {
    const id = this.nextId;
    this.nextId += 1;
    const inset = options?.inset ?? 0;
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
      `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
      `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${radius}"/></a:avLst></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` +
      "</p:spPr>" +
      `<p:txBody><a:bodyPr wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}"` +
      `${options?.anchor === "ctr" ? ' anchor="ctr"' : ""}><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
      paragraphs +
      "</p:txBody></p:sp>"
    );
  }

  /**
   * A filled preset shape with nothing to say — a bar, an arrow, a dot.
   *
   * These are decoration, so callers put them in `decorations`: written last,
   * their empty paragraphs land after the content, where extraction drops them.
   */
  private decorShape(
    prst: string,
    box: { x: number; y: number; width: number; height: number },
    colour: string,
  ): string {
    const id = this.nextId;
    this.nextId += 1;
    return (
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Decor ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
      `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
      `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>` +
      "</p:spPr>" +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>' +
      "</p:sp>"
    );
  }

  /** The title shape every archetype shares, differing only in box and style. */
  private titleShape(
    title: readonly Run[],
    index: number,
    box: { y: number; height: number },
    style: Style,
  ): string {
    return this.textShape(
      `Title ${index + 1}`,
      { x: SIDE_MARGIN, y: box.y, width: CONTENT_WIDTH, height: box.height },
      this.paragraph(title, style),
      '<p:ph type="title"/>',
    );
  }

  /**
   * A picture, placed at its aspect ratio.
   *
   * `noChangeAspect` is what keeps a reader's later resize honest, and the
   * empty `nvPr` is deliberate: a picture in a placeholder inherits the
   * placeholder's box, and this one has its own.
   */
  private picture(name: string, entry: MediaEntry): string {
    const id = this.nextId;
    this.nextId += 1;
    const relationship = this.relationshipFor("image", `../media/${entry.file}`);
    const placed = fitInto(entry.size, IMAGE_BOX);
    return (
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      `<p:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="${placed.x}" y="${placed.y}"/>` +
      `<a:ext cx="${placed.width}" cy="${placed.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    );
  }

  /** What every titled slide on the content layout gets: title and number. */
  private contentChrome(
    title: readonly Run[],
    index: number,
    shapes: string[],
    decorations: string[],
  ): void {
    shapes.push(
      this.titleShape(title, index, TITLE_BOX, {
        size: TITLE_SIZE,
        bold: true,
        indent: 0,
        leading: LEADING.deck.title,
      }),
    );
    decorations.push(this.slideNumber(index + 1, this.design.palette.inkMuted));
  }

  /** One slide, and the relationships it turned out to need. */
  slide(slide: Slide, index: number): { xml: string; rels: readonly SlideRelationship[] } {
    this.reset();
    const shapes: string[] = [];
    /**
     * Shapes that carry no content, appended after everything else.
     *
     * Their position on the slide is set by `a:xfrm` rather than by their place
     * in the tree, so writing them last costs nothing visually — and it is what
     * keeps their empty paragraphs out of the extracted text, where they would
     * otherwise land as blank lines in the middle of a slide.
     */
    const decorations: string[] = [];

    switch (slide.type) {
      case "cover": {
        shapes.push(
          this.titleShape(slide.title, index, COVER_TITLE_BOX, {
            size: COVER_TITLE_SIZE,
            bold: true,
            indent: 0,
            leading: LEADING.deck.coverTitle,
          }),
        );
        if (slide.subtitle) {
          shapes.push(
            this.textShape(
              "Subtitle",
              { x: SIDE_MARGIN, y: SUBTITLE_BOX.y, width: CONTENT_WIDTH, height: SUBTITLE_BOX.height },
              this.paragraph(slide.subtitle, {
                size: SUBTITLE_SIZE,
                colour: this.design.palette.inkMuted,
                indent: 0,
                leading: LEADING.deck.subtitle,
              }),
              '<p:ph type="body" idx="1"/>',
            ),
          );
        }
        break;
      }

      case "section": {
        // The ordinal leads the tree so extraction reads "01" then the title —
        // the order the slide is read in.
        shapes.push(
          this.textShape(
            "Ordinal",
            {
              x: SIDE_MARGIN,
              y: SECTION_ORDINAL_BOX.y,
              width: CONTENT_WIDTH,
              height: SECTION_ORDINAL_BOX.height,
            },
            this.paragraph([{ text: String(slide.ordinal).padStart(2, "0") }], {
              size: ORDINAL_SIZE,
              bold: true,
              colour: this.design.palette.onBrand,
              alpha: ORDINAL_ALPHA,
              indent: 0,
            }),
          ),
        );
        shapes.push(
          this.titleShape(slide.title, index, SECTION_TITLE_BOX, {
            size: SECTION_TITLE_SIZE,
            bold: true,
            colour: this.design.palette.onBrand,
            indent: 0,
            leading: LEADING.deck.title,
          }),
        );
        decorations.push(this.slideNumber(index + 1, this.design.palette.brandTint));
        break;
      }

      case "closing": {
        shapes.push(
          this.titleShape(slide.title, index, CLOSING_TITLE_BOX, {
            size: CLOSING_TITLE_SIZE,
            bold: true,
            indent: 0,
            align: "center",
            leading: LEADING.deck.title,
          }),
        );
        // What follows the goodbye — a contact line, a link — is centred with
        // it; a table here keeps its own alignment.
        this.stack(shapes, slide.pieces, CLOSING_BODY_BOX.y, (style) => ({
          ...style,
          align: style.align ?? "center",
          indent: 0,
        }));
        break;
      }

      case "cards": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const count = slide.cards.length;
        const width = Math.floor((CONTENT_WIDTH - (count - 1) * GRID_GAP) / count);
        slide.cards.forEach((card, at) => {
          const paragraphs =
            this.paragraph(card.title, {
              size: CARD_TITLE_SIZE,
              bold: true,
              colour: this.design.palette.brand,
              indent: 0,
            }) +
            (card.body
              ? this.paragraph(card.body, {
                  size: CARD_BODY_SIZE,
                  colour: this.design.palette.inkMuted,
                  indent: 0,
                  before: 600,
                })
              : "");
          shapes.push(
            this.roundedShape(
              `Card ${at + 1}`,
              { x: SIDE_MARGIN + at * (width + GRID_GAP), y: CARD_TOP, width, height: CARD_HEIGHT },
              this.design.palette.brandTint,
              this.design.deck.cardRadius,
              paragraphs,
              { inset: CARD_INSET },
            ),
          );
        });
        break;
      }

      case "metrics": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const count = slide.metrics.length;
        const width = Math.floor((CONTENT_WIDTH - (count - 1) * GRID_GAP) / count);
        slide.metrics.forEach((metric, at) => {
          shapes.push(
            this.textShape(
              `Metric ${at + 1}`,
              {
                x: SIDE_MARGIN + at * (width + GRID_GAP),
                y: METRIC_VALUE_BOX.y,
                width,
                height: METRIC_VALUE_BOX.height + METRIC_LABEL_BOX.height,
              },
              // The number is the point, so the number is the big thing; the
              // label hangs under it in the muted ink.
              this.paragraph([{ text: metric.value }], {
                size: METRIC_SIZE,
                bold: true,
                colour: this.design.palette.brand,
                indent: 0,
                align: "center",
              }) +
                this.paragraph(metric.label, {
                  size: METRIC_LABEL_SIZE,
                  colour: this.design.palette.inkMuted,
                  indent: 0,
                  align: "center",
                  before: 600,
                }),
            ),
          );
        });
        break;
      }

      case "quote": {
        this.contentChrome(slide.title, index, shapes, decorations);
        shapes.push(
          this.textShape(
            "Quote",
            {
              x: SIDE_MARGIN + QUOTE_INDENT,
              y: QUOTE_BOX.y,
              width: CONTENT_WIDTH - QUOTE_INDENT,
              height: QUOTE_BOX.height,
            },
            this.paragraph(slide.quote, { size: QUOTE_SIZE, italic: true, indent: 0 }),
          ),
        );
        if (slide.attribution) {
          shapes.push(
            this.textShape(
              "Attribution",
              {
                x: SIDE_MARGIN + QUOTE_INDENT,
                y: ATTRIBUTION_BOX.y,
                width: CONTENT_WIDTH - QUOTE_INDENT,
                height: ATTRIBUTION_BOX.height,
              },
              this.paragraph(slide.attribution, {
                size: METRIC_LABEL_SIZE,
                colour: this.design.palette.inkMuted,
                indent: 0,
              }),
            ),
          );
        }
        decorations.push(
          this.decorShape(
            "rect",
            { x: SIDE_MARGIN, y: QUOTE_BOX.y, width: QUOTE_BAR_WIDTH, height: QUOTE_BOX.height },
            this.design.palette.brandLight,
          ),
        );
        break;
      }

      case "process": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const count = slide.steps.length;
        const width = Math.floor((CONTENT_WIDTH - (count - 1) * PROCESS_GAP) / count);
        slide.steps.forEach((step, at) => {
          const x = SIDE_MARGIN + at * (width + PROCESS_GAP);
          shapes.push(
            this.roundedShape(
              `Step ${at + 1}`,
              { x, y: PROCESS_NODE_TOP, width, height: PROCESS_NODE_HEIGHT },
              this.design.palette.brandTint,
              this.design.deck.cardRadius,
              // One paragraph, with the author's number as its marker run: the
              // node extracts as "1. 접수 자동 분류", exactly the line that
              // went in.
              this.paragraph([{ text: `${at + 1}. ` }, ...step], {
                size: CARD_BODY_SIZE,
                indent: 0,
                align: "center",
                marker: this.design.palette.brand,
              }),
              { inset: 137160, anchor: "ctr" },
            ),
          );
          if (at < count - 1) {
            decorations.push(
              this.decorShape(
                "rightArrow",
                {
                  x: x + width + Math.round((PROCESS_GAP - PROCESS_ARROW.width) / 2),
                  y: PROCESS_NODE_TOP + Math.round((PROCESS_NODE_HEIGHT - PROCESS_ARROW.height) / 2),
                  width: PROCESS_ARROW.width,
                  height: PROCESS_ARROW.height,
                },
                this.design.palette.brandLight,
              ),
            );
          }
        });
        break;
      }

      case "timeline": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const count = slide.milestones.length;
        const cell = Math.floor(CONTENT_WIDTH / count);
        // The line goes into the tree before the dots: later shapes paint over
        // earlier ones, and a grey hairline across a brand dot is visible.
        decorations.push(
          this.decorShape(
            "rect",
            { x: SIDE_MARGIN, y: TIMELINE_LINE_Y, width: CONTENT_WIDTH, height: TIMELINE_LINE_HEIGHT },
            this.design.palette.rule,
          ),
        );
        slide.milestones.forEach((milestone, at) => {
          const x = SIDE_MARGIN + at * cell;
          shapes.push(
            this.textShape(
              `When ${at + 1}`,
              { x, y: TIMELINE_WHEN_BOX.y, width: cell, height: TIMELINE_WHEN_BOX.height },
              this.paragraph([{ text: milestone.when }], {
                size: CARD_TITLE_SIZE,
                bold: true,
                colour: this.design.palette.brand,
                indent: 0,
                align: "center",
              }),
            ),
          );
          shapes.push(
            this.textShape(
              `Milestone ${at + 1}`,
              { x, y: TIMELINE_WHAT_BOX.y, width: cell, height: TIMELINE_WHAT_BOX.height },
              this.paragraph(milestone.what, {
                size: CARD_BODY_SIZE,
                colour: this.design.palette.inkMuted,
                indent: 0,
                align: "center",
              }),
            ),
          );
          decorations.push(
            this.decorShape(
              "ellipse",
              {
                x: x + Math.round(cell / 2) - Math.round(TIMELINE_DOT / 2),
                y: TIMELINE_LINE_Y + Math.round(TIMELINE_LINE_HEIGHT / 2) - Math.round(TIMELINE_DOT / 2),
                width: TIMELINE_DOT,
                height: TIMELINE_DOT,
              },
              this.design.palette.brand,
            ),
          );
        });
        break;
      }

      case "comparison": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const width = Math.floor((CONTENT_WIDTH - COMPARE_GAP) / 2);
        slide.columns.forEach((column, at) => {
          const x = SIDE_MARGIN + at * (width + COMPARE_GAP);
          shapes.push(
            this.roundedShape(
              `Column ${at + 1}`,
              { x, y: BODY_BOX.y, width, height: CHIP_HEIGHT },
              this.design.palette.brand,
              CHIP_RADIUS,
              this.paragraph(column.title, {
                size: BODY_SIZE,
                bold: true,
                colour: this.design.palette.onBrand,
                indent: 0,
                align: "center",
              }),
              { anchor: "ctr" },
            ),
          );
          shapes.push(
            this.textShape(
              `Column ${at + 1} Lines`,
              {
                x,
                y: COMPARE_BODY_TOP,
                width,
                height: BODY_BOX.y + BODY_BOX.height - COMPARE_BODY_TOP,
              },
              column.lines
                .map((line) =>
                  this.paragraph(line.bullet ? [{ text: "• " }, ...line.runs] : line.runs, {
                    size: BODY_SIZE,
                    indent: 0,
                    before: 300,
                    ...(line.bullet ? { marker: this.design.palette.brandLight } : {}),
                  }),
                )
                .join(""),
            ),
          );
        });
        break;
      }

      case "image": {
        this.contentChrome(slide.title, index, shapes, decorations);
        const entry = this.media.get(slide.asset);
        if (entry) {
          shapes.push(this.picture(slide.asset, entry));
        }
        shapes.push(
          this.textShape(
            "Caption",
            {
              x: SIDE_MARGIN,
              y: IMAGE_CAPTION_BOX.y,
              width: CONTENT_WIDTH,
              height: IMAGE_CAPTION_BOX.height,
            },
            this.paragraph(slide.caption, {
              size: centiPoints(DECK.caption),
              colour: this.design.palette.inkMuted,
              indent: 0,
              align: "center",
            }),
          ),
        );
        break;
      }

      case "content": {
        if (slide.title) {
          shapes.push(
            this.titleShape(slide.title, index, TITLE_BOX, {
              size: TITLE_SIZE,
              bold: true,
              indent: 0,
              leading: LEADING.deck.title,
            }),
          );
        }
        this.stack(shapes, slide.pieces, BODY_BOX.y);
        decorations.push(this.slideNumber(index + 1, this.design.palette.inkMuted));
        break;
      }
    }

    if (shapes.length === 0) {
      // A slide with no shape at all opens, but there is nothing to select and
      // nothing in the outline. An empty body box is the honest empty slide.
      shapes.push(
        this.textShape(
          "Body 1",
          { x: SIDE_MARGIN, y: BODY_BOX.y, width: CONTENT_WIDTH, height: LINE_HEIGHT },
          this.paragraph([], BODY_STYLE),
          '<p:ph type="body" idx="1"/>',
        ),
      );
    }
    shapes.push(...decorations);

    return {
      xml:
        `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld>` +
        "<p:spTree>" +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
        shapes.join("") +
        "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
      rels: this.rels,
    };
  }
}
