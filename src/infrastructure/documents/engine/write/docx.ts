/**
 * A document AST to DOCX.
 *
 * The parts are written by hand rather than through a library, for the reason
 * the rest of this repository is: the surface actually used is small — six
 * parts, one of which is the body — and a library's idea of a paragraph is one
 * more thing between the AST and the bytes.
 *
 * Two decisions are worth naming.
 *
 * **Lists are literal markers with a hanging indent**, not `w:numPr` against a
 * `numbering.xml`. Real numbering is a second part, a definition per level per
 * list, and an abstract-numbering indirection — and what it buys is Word
 * renumbering a list the reader edits. Nothing here is edited before it is
 * read, and the literal form is what survives being extracted back to text,
 * which is how this server's own round trip checks itself.
 *
 * **No font is named.** The theme's default already carries an east-Asian face
 * on every platform Word runs on, and naming one — `Malgun Gothic`, say — is a
 * Windows font that a Mac substitutes for something else. Substitution chosen
 * by Word is better than substitution chosen here.
 */

import { escapeXml } from "../xml";
import { buildZip } from "../zip";
import { DocumentError } from "../errors";
import type { Align, Block, MarkdownDocument, Run } from "../markdown";
import { columnShares } from "./table";
import {
  extensionOf,
  fitInto,
  imageSize,
  type ImageAsset,
  type ImageSize,
} from "./image";
import {
  HANGUL,
  TOC_THRESHOLD,
  coverOf,
  figureOf,
  forceSemantic,
  tocEntriesOf,
  type Figure,
  type Metric,
  type Semantic,
} from "./semantics";
import {
  DOC,
  LEADING,
  TYPOGRAPHY,
  designFor,
  halfPoints,
  type DesignProfile,
  type DocumentProfile,
} from "./theme";
import { PRODUCER } from "../version";

/** A4, in twentieths of a point, with a 2.5cm margin. */
const PAGE = '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>';

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** One indent level, in twentieths of a point: 0.63cm, Word's own list step. */
const INDENT_STEP = 360;

/** rId1 styles, rId2 footer, rId3 header, rId4 settings when present; the rest follow. */
const FOOTER_RELATIONSHIP = "rId2";
const HEADER_RELATIONSHIP = "rId3";
const SETTINGS_RELATIONSHIP = "rId4";
const FIRST_LINK_RELATIONSHIP = 5;

/** What is left of the page once the margins are taken out — a full-width table. */
const TABLE_WIDTH = 11906 - 1418 * 2;

/** How far down the page the cover's title sits: a third, in twentieths. */
const COVER_DROP = 4200;
/** 635 EMU to the twentieth of a point, which is how a picture meets the page. */
const EMU_PER_TWIP = 635;

/**
 * The box a figure may fill: the text width, and three quarters of a page tall
 * — a picture that needs more than that is a page of its own, which is a
 * layout this renderer does not decide.
 */
const FIGURE_BOX = { x: 0, y: 0, width: TABLE_WIDTH * EMU_PER_TWIP, height: 6_858_000 };

const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";

const encoder = new TextEncoder();

function part(xml: string): Uint8Array {
  return encoder.encode(DECLARATION + xml);
}

/**
 * Text inside a `w:t`.
 *
 * `xml:space="preserve"` on every one of them: a run that begins or ends with a
 * space is ordinary — `**bold** text` produces exactly that — and without the
 * attribute Word drops it, closing up the gap between two words.
 */
function textElement(value: string): string {
  return value
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("<w:br/>");
}

/** A column's alignment as `w:jc`. Left is Word's default and needs no element. */
function justification(align: Align | undefined): string {
  if (align === "right") {
    return '<w:jc w:val="right"/>';
  }
  return align === "center" ? '<w:jc w:val="center"/>' : "";
}

/**
 * `colour` and `size` override whatever the run's styles would have given
 * them, and exist for the cases a `Run` cannot express: text on a brand-filled
 * table header, which has to be white regardless of what it is, or a cover
 * title set larger than the heading style it borrows. Putting either in the
 * AST would make presentation a property of the document rather than of the
 * rendering.
 */
function runProperties(run: Run, colour?: string, size?: number): string {
  const parts = [
    run.bold ? "<w:b/>" : "",
    run.italic ? "<w:i/>" : "",
    run.code ? '<w:rStyle w:val="CodeChar"/>' : "",
    run.href ? '<w:rStyle w:val="Hyperlink"/>' : "",
    colour ? `<w:color w:val="${colour}"/>` : "",
    size ? `<w:sz w:val="${size}"/>` : "",
  ].join("");
  return parts ? `<w:rPr>${parts}</w:rPr>` : "";
}

/** What the document's rels part needs to say about one relationship, in rId order. */
export interface DocRelationship {
  kind: "hyperlink" | "image";
  target: string;
}

class Renderer {
  /** Relationships in the order first seen; the index is the id. */
  private readonly rels: DocRelationship[] = [];
  /** Where each named asset's media part lives, in first-use order. */
  private readonly media = new Map<string, { file: string; size: ImageSize }>();
  /** `wp:docPr` ids, which Word wants unique across the document. */
  private nextDrawingId = 1;

  constructor(
    private readonly assets: Record<string, ImageAsset> = {},
    private readonly design: DesignProfile = designFor(),
  ) {}

  private relationshipFor(kind: DocRelationship["kind"], target: string): string {
    let index = this.rels.findIndex((rel) => rel.kind === kind && rel.target === target);
    if (index === -1) {
      index = this.rels.push({ kind, target }) - 1;
    }
    // rId1 is styles.xml, rId2 the footer and rId3 the header; the rest start above.
    return `rId${index + FIRST_LINK_RELATIONSHIP}`;
  }

  relationships(): readonly DocRelationship[] {
    return this.rels;
  }

  /** The media parts the document turned out to need, keyed by file name. */
  mediaParts(): ReadonlyMap<string, Uint8Array> {
    const parts = new Map<string, Uint8Array>();
    for (const [name, entry] of this.media) {
      parts.set(entry.file, this.assets[name]!.bytes);
    }
    return parts;
  }

  /** The extensions the content types must declare, in first-use order. */
  mediaExtensions(): readonly string[] {
    return [...new Set([...this.media.keys()].map((name) => extensionOf(this.assets[name]!.mimeType)))];
  }

  /**
   * Runs, with consecutive links to the same target wrapped in one
   * `w:hyperlink`. Word treats two adjacent hyperlink elements as two links, so
   * `[**bold** text](url)` would otherwise be two clickable pieces with a seam.
   */
  private runs(runs: readonly Run[], colour?: string, size?: number): string {
    let out = "";
    for (let index = 0; index < runs.length; ) {
      const href = runs[index]!.href;
      if (!href) {
        out += `<w:r>${runProperties(runs[index]!, colour, size)}${textElement(runs[index]!.text)}</w:r>`;
        index += 1;
        continue;
      }
      let end = index;
      while (end < runs.length && runs[end]!.href === href) {
        end += 1;
      }
      const inner = runs
        .slice(index, end)
        .map((run) => `<w:r>${runProperties(run, colour, size)}${textElement(run.text)}</w:r>`)
        .join("");
      out += `<w:hyperlink r:id="${this.relationshipFor("hyperlink", href)}">${inner}</w:hyperlink>`;
      index = end;
    }
    return out;
  }

  private paragraph(runs: readonly Run[], properties = "", colour?: string, size?: number): string {
    return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${this.runs(runs, colour, size)}</w:p>`;
  }

  private list(block: Extract<Block, { kind: "list" }>): string {
    // One counter per depth, reset whenever the list steps back out — so a
    // nested list numbers from 1 each time it is entered rather than carrying
    // on from where the previous nested list left off.
    const counters: number[] = [];
    return block.items
      .map((item) => {
        counters.length = item.depth + 1;
        counters[item.depth] = (counters[item.depth] ?? 0) + 1;
        const marker = block.ordered ? `${counters[item.depth]}. ` : "- ";
        const left = INDENT_STEP * (item.depth + 1);
        return this.paragraph([{ text: marker }, ...item.runs], `<w:ind w:left="${left}" w:hanging="${INDENT_STEP}"/>`);
      })
      .join("");
  }

  private table(block: Extract<Block, { kind: "table" }>): string {
    const width = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
    const widths = columnShares([block.header, ...block.rows], width).map((share) =>
      Math.round(share * TABLE_WIDTH),
    );
    const cell = (runs: readonly Run[], row: number, column: number): string => {
      const header = row === 0;
      // Zebra on alternate data rows. Counted from the header so the first data
      // row is the plain one — a tint immediately under a filled header reads as
      // the header being two rows tall.
      const fill = header
        ? this.design.table.headerFill
        : row % 2 === 0
          ? this.design.palette.brandTint
          : undefined;
      return (
        `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>` +
        (fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : "") +
        "</w:tcPr>" +
        // A `w:tc` with no `w:p` in it is what makes Word call a file corrupt, so
        // an empty cell still gets an empty paragraph.
        this.paragraph(
          header ? runs.map((run) => ({ ...run, bold: true })) : runs,
          justification(block.align[column]) +
            `<w:spacing w:line="${Math.round(240 * LEADING.document.compact)}" w:lineRule="auto"/>`,
          header ? this.design.table.headerText : undefined,
        ) +
        "</w:tc>"
      );
    };
    const row = (cells: readonly Run[][], index: number): string =>
      "<w:tr>" +
      // The header repeats when the table breaks across pages; a column of
      // numbers with no heading over it is a column nobody can read.
      (index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "") +
      Array.from({ length: width }, (_, column) => cell(cells[column] ?? [], index, column)).join("") +
      "</w:tr>";
    const grid = `<w:tblGrid>${widths.map((value) => `<w:gridCol w:w="${value}"/>`).join("")}</w:tblGrid>`;
    // Horizontal rules only. A full grid boxes every number in; the eye reads a
    // table by its rows, and the vertical lines are doing no work the column
    // gaps are not already doing.
    const edge = (name: string): string =>
      `<w:${name} w:val="single" w:sz="4" w:color="${this.design.palette.rule}"/>`;
    const borders =
      "<w:tblBorders>" +
      edge("top") +
      edge("bottom") +
      edge("insideH") +
      '<w:left w:val="none" w:sz="0" w:space="0"/><w:right w:val="none" w:sz="0" w:space="0"/>' +
      '<w:insideV w:val="none" w:sz="0" w:space="0"/></w:tblBorders>';
    return (
      // A fixed layout with a grid, rather than `auto`: autofit sizes columns to
      // whatever is shortest, which for a two-column table of a label and a
      // sentence produces a table an inch wide in the corner of the page.
      `<w:tbl><w:tblPr><w:tblW w:w="${TABLE_WIDTH}" w:type="dxa"/>` +
      `<w:tblLayout w:type="fixed"/>${borders}</w:tblPr>${grid}` +
      row(block.header, 0) +
      block.rows.map((cells, index) => row(cells, index + 1)).join("") +
      // Word wants a paragraph between a table and whatever follows it,
      // including the end of the body.
      "</w:tbl><w:p/>"
    );
  }

  /**
   * The cover: a short brand rule a third down the page, the title under it in
   * the cover size, the subtitle in the muted ink, and a page break.
   *
   * The title paragraph is `Heading1` with the size and colour overridden
   * inline — not a style of its own — because the style id is what this
   * server's own reader maps back to `#`. A cover styled any other way reads
   * back as a document that lost its title.
   */
  cover(title: readonly Run[], subtitle: readonly Run[] | undefined): string {
    const rule =
      `<w:p><w:pPr><w:spacing w:before="${COVER_DROP}" w:after="160"/>` +
      `<w:ind w:right="${TABLE_WIDTH - Math.round(this.design.doc.coverRulePoints * 20)}"/>` +
      `<w:pBdr><w:bottom w:val="single" w:sz="24" w:space="1" w:color="${this.design.palette.brand}"/></w:pBdr>` +
      "</w:pPr></w:p>";
    const titleParagraph = this.paragraph(
      title,
      '<w:pStyle w:val="Heading1"/>' +
        '<w:pBdr><w:bottom w:val="none" w:sz="0" w:space="0"/></w:pBdr>' +
        `<w:spacing w:before="0" w:after="240" w:line="${Math.round(240 * LEADING.document.coverTitle)}" w:lineRule="auto"/>`,
      this.design.palette.ink,
      halfPoints(DOC.coverTitle),
    );
    const subtitleParagraph = subtitle
      ? this.paragraph(
          subtitle,
          `<w:spacing w:after="0" w:line="${Math.round(240 * LEADING.document.subtitle)}" w:lineRule="auto"/>`,
          this.design.palette.inkMuted,
          halfPoints(DOC.subtitle),
        )
      : "";
    return rule + titleParagraph + subtitleParagraph + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  /**
   * The contents page: a heading-sized label and a `TOC` field whose result is
   * computed *here*, without page numbers.
   *
   * The `\n` switch is the decision that makes the rest honest. Page numbers
   * are the one thing about a contents page this renderer cannot know — text
   * reflows to the reader's fonts — and the first design asked Word to fill
   * them in via `settings.xml`'s `updateFields`, which turns out to greet
   * every reader with a dialog about fields referring to other files. A
   * contents page that lists the headings and skips the numbers is one this
   * renderer can finish itself: correct as written, no update to ask for, no
   * dialog. The field wrapper stays, so a reader who edits the headings can
   * still press F9 and have Word regenerate the list.
   *
   * The label is styled like a level 1 heading but is deliberately not one: a
   * Heading paragraph carries an outline level, and a table of contents that
   * lists itself is the oldest TOC bug there is.
   */
  tocPage(label: string, entries: readonly { runs: readonly Run[]; level: number }[]): string {
    const heading = this.paragraph(
      [{ text: label, bold: true }],
      '<w:spacing w:before="0" w:after="240"/>' +
        `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${this.design.palette.brandLight}"/></w:pBdr>`,
      this.design.palette.brand,
      halfPoints(DOC.headings[0]),
    );
    // A multi-paragraph field cannot be a `fldSimple`, which is a run-level
    // element: the begin, the instruction and the separator open the first
    // entry's paragraph, and the end closes the last one's — the shape Word
    // itself writes a TOC in.
    const open =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\n </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    const close = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const cached = entries
      .map((entry, at) => {
        const properties =
          `<w:pPr><w:spacing w:after="60"/><w:ind w:left="${(entry.level - 1) * INDENT_STEP}"/></w:pPr>`;
        const colour =
          entry.level === 1
            ? ""
            : `<w:rPr><w:color w:val="${this.design.palette.inkMuted}"/></w:rPr>`;
        // Plain text, not the heading's runs: a bold word mid-heading is
        // emphasis in the body, noise in a list of contents.
        const text = textElement(entry.runs.map((run) => run.text).join(""));
        return (
          "<w:p>" +
          properties +
          (at === 0 ? open : "") +
          `<w:r>${colour}${text}</w:r>` +
          (at === entries.length - 1 ? close : "") +
          "</w:p>"
        );
      })
      .join("");
    return heading + cached + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  /**
   * What stands at the top of a chapter's page: its number, large and in the
   * light brand — a mark, not text. The page break rides on this paragraph,
   * except when nothing has been set yet and a break would make an empty page.
   */
  chapterOpener(ordinal: number, breakBefore: boolean): string {
    return this.paragraph(
      [{ text: String(ordinal).padStart(2, "0"), bold: true }],
      `${breakBefore ? "<w:pageBreakBefore/>" : ""}<w:spacing w:before="0" w:after="0"/>`,
      this.design.palette.brandLight,
      halfPoints(DOC.ordinal),
    );
  }

  /**
   * A figure: the picture centred at its aspect ratio, the caption under it.
   *
   * The bytes were sent by name alongside the Markdown; a reference with none
   * behind it is refused here by name, because a report with a silently absent
   * picture reads as "the image was empty", which is the wrong claim.
   */
  private figure(figure: Figure): string {
    const asset = Object.hasOwn(this.assets, figure.asset) ? this.assets[figure.asset] : undefined;
    if (!asset) {
      throw new DocumentError(
        `the document references asset://${figure.asset} but no asset of that name was provided`,
      );
    }
    let entry = this.media.get(figure.asset);
    if (!entry) {
      entry = {
        file: `image${this.media.size + 1}.${extensionOf(asset.mimeType)}`,
        size: imageSize(asset.bytes, asset.mimeType),
      };
      this.media.set(figure.asset, entry);
    }
    const relationship = this.relationshipFor("image", `media/${entry.file}`);
    const placed = fitInto(entry.size, FIGURE_BOX);
    const id = this.nextDrawingId;
    this.nextDrawingId += 1;
    const drawing =
      '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${placed.width}" cy="${placed.height}"/>` +
      `<wp:docPr id="${id}" name="${escapeXml(figure.asset)}"/>` +
      `<a:graphic><a:graphicData uri="${PIC}">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${escapeXml(figure.asset)}"/>` +
      "<pic:cNvPicPr/></pic:nvPicPr>" +
      `<pic:blipFill><a:blip r:embed="${relationship}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${placed.width}" cy="${placed.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>";
    return (
      `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr><w:r>${drawing}</w:r></w:p>` +
      this.paragraph(
        figure.caption,
        '<w:jc w:val="center"/><w:spacing w:after="240"/>',
        this.design.palette.inkMuted,
        halfPoints(DOC.caption),
      )
    );
  }

  block(block: Block): string {
    switch (block.kind) {
      case "heading":
        return this.paragraph(block.runs, `<w:pStyle w:val="Heading${block.level}"/>`);
      case "paragraph": {
        // A paragraph that is exactly one asset image is a figure; an image
        // inside prose stays the link it has always been.
        const figure = figureOf(block);
        return figure ? this.figure(figure) : this.paragraph(block.runs);
      }
      case "list":
        return this.list(block);
      case "code":
        // One paragraph per line rather than one paragraph with breaks: a long
        // listing then breaks across pages instead of overflowing one.
        return (block.text === "" ? [""] : block.text.split("\n"))
          .map((line) => this.paragraph([{ text: line }], '<w:pStyle w:val="Code"/>'))
          .join("");
      case "quote":
        return this.paragraph(block.runs, '<w:pStyle w:val="Quote"/>');
      case "table":
        return this.table(block);
      case "rule":
        return this.paragraph(
          [],
          `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${this.design.palette.rule}"/></w:pBdr>`,
        );
      case "directive": {
        // A named semantic the author asked for gets its page treatment; the
        // rest unwrap, because a flowing page already reads a list as a list.
        // Recognition is never automatic here — a document is prose, and prose
        // transformed unasked is prose misquoted. The deck recognises; the
        // page waits to be told.
        const semantic = forceSemantic(block.name, block.blocks);
        if (semantic?.kind === "metrics") {
          return this.metricsStrip(semantic.metrics);
        }
        if (semantic?.kind === "comparison") {
          return this.table(comparisonTable(semantic));
        }
        return block.blocks.map((inner) => this.block(inner)).join("");
      }
    }
  }

  /**
   * A row of key figures: the number large in the brand colour, its name in
   * the caption size under it. A borderless table, because a row of aligned
   * cells is exactly what a table is — just not one that looks like a grid.
   */
  private metricsStrip(metrics: readonly Metric[]): string {
    const width = Math.floor(TABLE_WIDTH / metrics.length);
    const cells = metrics
      .map(
        (metric) =>
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
          this.paragraph(
            [{ text: metric.value, bold: true }],
            '<w:jc w:val="center"/><w:spacing w:after="40"/>',
            this.design.palette.brand,
            halfPoints(DOC.metric),
          ) +
          this.paragraph(
            metric.label,
            '<w:jc w:val="center"/>',
            this.design.palette.inkMuted,
            halfPoints(DOC.caption),
          ) +
          "</w:tc>",
      )
      .join("");
    const grid = metrics.map(() => `<w:gridCol w:w="${width}"/>`).join("");
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="${TABLE_WIDTH}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
      "<w:tblBorders>" +
      ["top", "bottom", "left", "right", "insideH", "insideV"]
        .map((edge) => `<w:${edge} w:val="none" w:sz="0" w:space="0"/>`)
        .join("") +
      `</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>` +
      `<w:tr>${cells}</w:tr></w:tbl><w:p/>`
    );
  }
}

/**
 * A comparison, said as a table — which is what a page does well. The chip
 * headers a slide draws become the header row, and the columns' lines zip
 * into rows; the table renderer supplies the brand header and the rules.
 */
function comparisonTable(semantic: Extract<Semantic, { kind: "comparison" }>): Extract<Block, { kind: "table" }> {
  const [left, right] = semantic.columns;
  const depth = Math.max(left.lines.length, right.lines.length);
  return {
    kind: "table",
    header: [left.title, right.title],
    rows: Array.from({ length: depth }, (_, at) => [
      left.lines[at]?.runs ?? [],
      right.lines[at]?.runs ?? [],
    ]),
    align: ["left", "left"],
  };
}

function documentXml(document: MarkdownDocument, renderer: Renderer): string {
  const { cover, body } = coverOf(document.blocks);
  let out = cover ? renderer.cover(cover.title, cover.subtitle) : "";
  // A contents page, when there is a cover to follow and enough structure to
  // list. A memo gets none; a report gets one whether or not it asked, because
  // a reader deciding whether to read is what a contents page is for.
  const entries = tocEntriesOf(body);
  if (cover && entries.length >= TOC_THRESHOLD) {
    const korean = HANGUL.test(cover.title.map((run) => run.text).join(""));
    out += renderer.tocPage(korean ? "목차" : "Contents", entries);
  }
  /** Whether a page break before the next chapter has anything to move past. */
  let rendered = cover !== undefined;
  let ordinal = 0;
  for (const block of body) {
    if (block.kind === "heading" && block.level === 1) {
      ordinal += 1;
      out += renderer.chapterOpener(ordinal, rendered);
    }
    out += renderer.block(block);
    rendered = true;
  }
  return (
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">` +
    // The header and footer references come before the page size: `w:sectPr`
    // puts its references first, and Word rejects the other order. `titlePg`
    // comes after the margins for the same schema reason, and is what keeps
    // the cover free of the running head and the page number.
    `<w:body>${out}<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="${HEADER_RELATIONSHIP}"/>` +
    `<w:footerReference w:type="default" r:id="${FOOTER_RELATIONSHIP}"/>${PAGE}` +
    (cover ? "<w:titlePg/>" : "") +
    "</w:sectPr></w:body></w:document>"
  );
}

/**
 * `settings.xml`, present only for a document with Korean in it.
 *
 * This is the no-name font policy finished, not bent: no face is ever named,
 * but a document that does not say its east-Asian text is Korean leaves a
 * non-Korean Word to guess — and Word's guess is its *locale's* CJK default,
 * which on an English or Japanese machine is a Chinese or Japanese face
 * rendering 한글 through the wrong font's fallback. `themeFontLang` states the
 * language; the face is still the reader's system default for it (맑은 고딕 on
 * Windows, Apple SD Gothic Neo on a Mac). Note what this part does *not*
 * carry: `updateFields`, which put a dialog in front of every reader once.
 */
function settingsXml(): string {
  return `<w:settings xmlns:w="${W}"><w:themeFontLang w:val="en-US" w:eastAsia="ko-KR"/></w:settings>`;
}

/** The running head: the document's name, quietly, on every page but the cover. */
function headerXml(title: string, design: DesignProfile): string {
  const properties =
    `<w:rPr><w:color w:val="${design.palette.inkMuted}"/><w:sz w:val="${halfPoints(DOC.caption)}"/></w:rPr>`;
  return (
    `<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p>` +
    '<w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr>' +
    `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r>` +
    "</w:p></w:hdr>"
  );
}

/**
 * The page number, as a field rather than as a number.
 *
 * `PAGE` is computed by Word when the document is opened or printed, which is
 * the only way a footer can be right in a document whose length this renderer
 * does not decide — text reflows to the reader's fonts, and a number written
 * here would be wrong the first time it did.
 */
function footerXml(design: DesignProfile): string {
  const properties =
    `<w:rPr><w:color w:val="${design.palette.inkMuted}"/><w:sz w:val="${halfPoints(DOC.caption)}"/></w:rPr>`;
  return (
    `<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p>` +
    '<w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr>' +
    '<w:fldSimple w:instr=" PAGE ">' +
    `<w:r>${properties}<w:t>1</w:t></w:r>` +
    "</w:fldSimple></w:p></w:ftr>"
  );
}

function stylesXml(korean: boolean, design: DesignProfile): string {
  // Levels 1 and 2 carry a hairline instead of a full-bleed tint: it preserves
  // the hierarchy on screen, in print and through a photocopier with a
  // hundredth of the ink.
  const underline =
    `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${design.palette.brandLight}"/></w:pBdr>`;
  const heading = (level: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 240 : 200}" w:after="80" ` +
    `w:line="${Math.round(240 * LEADING.document.heading)}" w:lineRule="auto"/>` +
    (level <= 2 ? underline : "") +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:color w:val="${design.palette.brand}"/>` +
    `<w:sz w:val="${halfPoints(DOC.headings[level - 1] ?? DOC.body)}"/></w:rPr></w:style>`;
  return (
    `<w:styles xmlns:w="${W}">` +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    // A Korean document sets its Latin through the east-Asian theme slot too —
    // still no face named, but the *same* system face for both scripts. Left
    // alone, Word splits a Korean sentence across two fonts: 한글 in the EA
    // default and the Latin words beside it in Calibri, which is the mixed
    // look every Korean house style exists to prevent. Code keeps Consolas:
    // the Code styles carry their own rFonts, which beat this default.
    (korean
      ? '<w:rFonts w:asciiTheme="minorEastAsia" w:hAnsiTheme="minorEastAsia" w:eastAsiaTheme="minorEastAsia"/>'
      : "") +
    `<w:color w:val="${design.palette.ink}"/>` +
    `<w:sz w:val="${halfPoints(DOC.body)}"/>` +
    `<w:spacing w:val="${TYPOGRAPHY.tracking}"/><w:kern w:val="${halfPoints(TYPOGRAPHY.kerningFromPoints)}"/>` +
    // Every run states its east-Asian language once, here, when the document
    // has Korean in it — the run-level half of what `settingsXml` says.
    (korean ? '<w:lang w:val="en-US" w:eastAsia="ko-KR"/>' : "") +
    "</w:rPr></w:rPrDefault>" +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="${Math.round(240 * LEADING.document.body)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    [1, 2, 3, 4, 5, 6].map(heading).join("") +
    // A quote is a callout: the brand bar on the left, the tint behind it —
    // the quiet way a professional page marks an aside. The
    // shading spans the paragraph's indent box, so the bar and the ground read
    // as one device.
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="720" w:right="360"/><w:spacing w:before="120" w:after="160"/>' +
    `<w:shd w:val="clear" w:color="auto" w:fill="${design.palette.brandTint}"/>` +
    `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="${design.palette.brandLight}"/></w:pBdr></w:pPr>` +
    `<w:rPr><w:i/><w:color w:val="${design.palette.inkMuted}"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>' +
    `<w:pPr><w:spacing w:after="0" w:line="${Math.round(240 * LEADING.document.compact)}" w:lineRule="auto"/><w:ind w:left="360"/>` +
    `<w:shd w:val="clear" w:color="auto" w:fill="${design.palette.brandTint}"/></w:pPr>` +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' +
    `<w:sz w:val="${halfPoints(DOC.code)}"/></w:rPr></w:style>` +
    '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' +
    `<w:sz w:val="${halfPoints(DOC.code)}"/><w:color w:val="${design.palette.brandDeep}"/></w:rPr></w:style>` +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    `<w:rPr><w:color w:val="${design.palette.brandDeep}"/><w:u w:val="single"/></w:rPr></w:style>` +
    "</w:styles>"
  );
}

/**
 * `docProps/app.xml`, whose only job here is to say what wrote the file.
 *
 * OOXML keeps the producer separate from the core properties: `dc:title` and the
 * dates are the document's, `<Application>` is the tool's. Word fills in a dozen
 * more fields — word counts, template names — and none of them are things this
 * renderer knows or a reader needs. When somebody turns up with a file that
 * renders oddly, this is the line that says which release made it.
 */
function appPropertiesXml(): string {
  return (
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>${escapeXml(PRODUCER)}</Application>` +
    "</Properties>"
  );
}

/** The media types a `<Default>` can carry, keyed by the extension it names. */
const MEDIA_DEFAULTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
};

function contentTypesXml(mediaExtensions: readonly string[], settings: boolean): string {
  return (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    mediaExtensions
      .map((extension) => `<Default Extension="${extension}" ContentType="${MEDIA_DEFAULTS[extension]}"/>`)
      .join("") +
    (settings
      ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      : "") +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>"
  );
}

function packageRelsXml(): string {
  return (
    `<Relationships xmlns="${RELATIONSHIPS}">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${RELATIONSHIPS}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/>` +
    "</Relationships>"
  );
}

function documentRelsXml(rels: readonly DocRelationship[], settings: boolean): string {
  return (
    `<Relationships xmlns="${RELATIONSHIPS}">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="${FOOTER_RELATIONSHIP}" Type="${R}/footer" Target="footer1.xml"/>` +
    `<Relationship Id="${HEADER_RELATIONSHIP}" Type="${R}/header" Target="header1.xml"/>` +
    (settings
      ? `<Relationship Id="${SETTINGS_RELATIONSHIP}" Type="${R}/settings" Target="settings.xml"/>`
      : "") +
    rels
      .map((rel, index) =>
        rel.kind === "hyperlink"
          ? `<Relationship Id="rId${index + FIRST_LINK_RELATIONSHIP}" Type="${R}/hyperlink" Target="${escapeXml(rel.target)}" TargetMode="External"/>`
          : `<Relationship Id="rId${index + FIRST_LINK_RELATIONSHIP}" Type="${R}/image" Target="${escapeXml(rel.target)}"/>`,
      )
      .join("") +
    "</Relationships>"
  );
}

function corePropertiesXml(title: string, created: string): string {
  return (
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

export interface DocxOptions {
  title: string;
  /** ISO 8601, passed in so the bytes are a function of the input alone. */
  created: string;
  profile?: DocumentProfile;
  /** Keyed by the name `asset://name` references. */
  assets?: Record<string, ImageAsset>;
}

export function renderDocx(document: MarkdownDocument, options: DocxOptions): Uint8Array {
  const design = designFor(options.profile);
  const renderer = new Renderer(options.assets, design);
  // Before the relationships and media parts: rendering is what discovers
  // the hyperlinks and the pictures.
  const body = documentXml(document, renderer);
  // The rendered body is the whole of the document's text, so it is what
  // decides whether the language parts say Korean.
  const korean = HANGUL.test(body) || HANGUL.test(options.title);
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": part(contentTypesXml(renderer.mediaExtensions(), korean)),
    "_rels/.rels": part(packageRelsXml()),
    "docProps/core.xml": part(corePropertiesXml(options.title, options.created)),
    "docProps/app.xml": part(appPropertiesXml()),
    "word/document.xml": part(body),
    "word/_rels/document.xml.rels": part(documentRelsXml(renderer.relationships(), korean)),
    "word/styles.xml": part(stylesXml(korean, design)),
    "word/footer1.xml": part(footerXml(design)),
    "word/header1.xml": part(headerXml(options.title, design)),
  };
  if (korean) {
    parts["word/settings.xml"] = part(settingsXml());
  }
  for (const [file, bytes] of renderer.mediaParts()) {
    parts[`word/media/${file}`] = bytes;
  }
  return buildZip(parts);
}
