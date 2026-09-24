/**
 * A document AST to HWPX.
 *
 * HWPX is OWPML (KS X 6101) in an ODF-style zip. Unlike OOXML it has no
 * defaults worth relying on: a paragraph refers to a `paraPr` by id and a run
 * refers to a `charPr` by id, and both tables live in `Contents/header.xml`. So
 * the header is not boilerplate here — it is half the renderer, and the ids in
 * it are the vocabulary the body is written in.
 *
 * The character properties are **enumerated rather than composed**: there are
 * sixteen of them, one per combination of bold, italic, code and link, and the
 * id is the bit pattern. Emitting one on demand would mean a second pass over
 * the document to collect them before the header could be written, and the
 * sixteen cost a few hundred bytes.
 *
 * Lists carry literal markers, as in the DOCX renderer, rather than an OWPML
 * numbering definition — for the same reason and with the same trade: nothing
 * here is edited before it is read, and the literal form survives extraction
 * back to text, which is how this server's round trip checks itself.
 *
 * **This is the format with the least margin for error.** DOCX and PDF have
 * many independent implementations and all of them are forgiving; HWPX has
 * essentially one reader that matters, and it either opens a file or does not.
 * Everything below follows the spec's element order and attribute set as
 * closely as it can for that reason.
 */

import { escapeXml } from "../xml";
import { buildZip, stored } from "../zip";
import type { Block, MarkdownDocument, Run } from "../markdown";
import { columnShares } from "./table";
import { HANGUL, TOC_THRESHOLD, coverOf, tocEntriesOf, type Cover } from "./semantics";
import {
  DOC,
  LEADING,
  centiPoints,
  designFor,
  hashed,
  type DesignProfile,
  type DocumentProfile,
} from "./theme";
import { PRODUCER, SERVER_NAME, SERVER_VERSION } from "../version";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const NS = {
  head: "http://www.hancom.co.kr/hwpml/2011/head",
  section: "http://www.hancom.co.kr/hwpml/2011/section",
  paragraph: "http://www.hancom.co.kr/hwpml/2011/paragraph",
  core: "http://www.hancom.co.kr/hwpml/2011/core",
  app: "http://www.hancom.co.kr/hwpml/2011/app",
  version: "http://www.hancom.co.kr/hwpml/2011/version",
  opf: "http://www.idpf.org/2007/opf/",
  ocf: "urn:oasis:names:tc:opendocument:xmlns:container",
  manifest: "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0",
} as const;

/**
 * HWPUNIT is 1/7200 inch, so A4 is 59,528 x 84,188 and a 20mm margin is 5,669.
 * Character sizes are in hundredths of a point: 1000 is 10pt.
 */
const PAGE = { width: 59528, height: 84188 } as const;
const MARGIN = { left: 5669, right: 5669, top: 5669, bottom: 4252, header: 4252, footer: 4252 } as const;
/** What is left for text once the margins are taken out — a table's width. */
const TEXT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const BODY_SIZE = centiPoints(DOC.body);
const CODE_SIZE = centiPoints(DOC.code);
const HEADING_SIZES = DOC.headings.map(centiPoints);

/** One indent step, in HWPUNIT: about 7mm. */
const INDENT_STEP = 2000;

/** `charPr` ids are the bit pattern of the styles they carry. */
const BOLD = 1;
const ITALIC = 2;
const CODE = 4;
const LINK = 8;
/** Headings occupy the ids just past the sixteen combinations; then the quote. */
const HEADING_CHAR_BASE = 16;
const QUOTE_CHAR = 22;
/** White and bold, for the one place a run's own styles cannot say what it needs: a filled header cell. */
const TABLE_HEADER_CHAR = 23;
/** The cover's title and subtitle, a chapter's ordinal, a contents sub-entry. */
const COVER_TITLE_CHAR = 24;
const SUBTITLE_CHAR = 25;
const ORDINAL_CHAR = 26;
const TOC_MUTED_CHAR = 27;
const CHAR_COUNT = TOC_MUTED_CHAR + 1;

/** `paraPr` ids: body, six indent levels, code, quote, heading. */
const PARA_BODY = 0;
const PARA_INDENT_BASE = 1;
const PARA_INDENT_LEVELS = 5;
const PARA_CODE = PARA_INDENT_BASE + PARA_INDENT_LEVELS;
const PARA_QUOTE = PARA_CODE + 1;
const PARA_HEADING = PARA_QUOTE + 1;
/** Table cells, with a compact line rhythm and their requested alignment. */
const PARA_TABLE_LEFT = PARA_HEADING + 1;
const PARA_CENTER = PARA_TABLE_LEFT + 1;
const PARA_RIGHT = PARA_CENTER + 1;
/** The cover rule, title and subtitle use their own spacing roles. */
const PARA_COVER_RULE = PARA_RIGHT + 1;
const PARA_COVER = PARA_COVER_RULE + 1;
const PARA_SUBTITLE = PARA_COVER + 1;
/** A contents sub-entry, indented one step with no hanging. */
const PARA_TOC2 = PARA_SUBTITLE + 1;
const PARA_COUNT = PARA_TOC2 + 1;

/**
 * Border fills, by id.
 *
 * A cell gets horizontal rules only — a full grid boxes every number in, and the
 * eye reads a table by its rows. The heading rule is a fill with nothing but a
 * bottom edge, which is how OWPML puts a line under a paragraph.
 */
const FILL_NONE = 1;
const FILL_CELL = 2;
const FILL_HEADER = 3;
const FILL_ZEBRA = 4;
const FILL_HEADING_RULE = 5;
const FILL_COVER_RULE = 6;
const FILL_COUNT = 6;

const encoder = new TextEncoder();

function part(xml: string): Uint8Array {
  return encoder.encode(DECLARATION + xml);
}

function plainOf(runs: readonly Run[]): string {
  return runs.map((run) => run.text).join("");
}

function charIdOf(run: Run): number {
  return (
    (run.bold ? BOLD : 0) | (run.italic ? ITALIC : 0) | (run.code ? CODE : 0) | (run.href ? LINK : 0)
  );
}

/* ------------------------------------------------------------------ header */

const FONT_LANGUAGES = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"] as const;

/**
 * Two faces, referred to by index: 0 for prose and 1 for code.
 *
 * Both ship with 한글 itself, which is the only guarantee available — a font
 * named here and absent on the reader's machine is substituted by something
 * with different metrics, and for the code face that means a listing that no
 * longer lines up.
 */
const FONTS = ["함초롬바탕", "굴림체"];

function fontfaces(): string {
  const face = (name: string, id: number): string =>
    `<hh:font id="${id}" face="${escapeXml(name)}" type="TTF" isEmbedded="0">` +
    '<hh:typeInfo familyType="FCAT_UNKNOWN" weight="0" proportion="0" contrast="0" strokeVariation="0" ' +
    'armStyle="0" letterform="0" midline="0" xHeight="0"/></hh:font>';
  return (
    `<hh:fontfaces itemCnt="${FONT_LANGUAGES.length}">` +
    FONT_LANGUAGES.map(
      (language) =>
        `<hh:fontface lang="${language}" fontCnt="${FONTS.length}">` +
        FONTS.map(face).join("") +
        "</hh:fontface>",
    ).join("") +
    "</hh:fontfaces>"
  );
}

interface Fill {
  /** Which edges are drawn, and in what colour. */
  edges?: { sides: "horizontal" | "bottom"; colour: string; width?: string };
  /** A solid ground behind the cell. */
  ground?: string;
}

function fillsFor(design: DesignProfile): Record<number, Fill> {
  const { palette } = design;
  return {
    [FILL_NONE]: {},
    [FILL_CELL]: { edges: { sides: "horizontal", colour: hashed("rule", palette) } },
    [FILL_HEADER]: {
      edges: { sides: "horizontal", colour: hashed("brand", palette) },
      ground: `#${design.table.headerFill}`,
    },
    [FILL_ZEBRA]: {
      edges: { sides: "horizontal", colour: hashed("rule", palette) },
      ground: hashed("brandTint", palette),
    },
    [FILL_HEADING_RULE]: {
      edges: { sides: "bottom", colour: hashed("brandLight", palette), width: "0.4 mm" },
    },
    [FILL_COVER_RULE]: {
      edges: { sides: "bottom", colour: hashed("brand", palette), width: "1.0 mm" },
    },
  };
}

function borderFill(id: number, fills: Readonly<Record<number, Fill>>, design: DesignProfile): string {
  const fill = fills[id] ?? {};
  const edge = (name: string, drawn: boolean): string =>
    `<hh:${name} type="${drawn ? "SOLID" : "NONE"}" ` +
    `width="${fill.edges?.width ?? "0.12 mm"}" color="${fill.edges?.colour ?? hashed("rule", design.palette)}"/>`;
  const sides = fill.edges?.sides;
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">` +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/>' +
    '<hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    edge("leftBorder", false) +
    edge("rightBorder", false) +
    edge("topBorder", sides === "horizontal") +
    edge("bottomBorder", sides !== undefined) +
    `<hh:diagonal type="NONE" width="0.1 mm" color="${hashed("ink", design.palette)}"/>` +
    (fill.ground
      ? `<hc:fillBrush><hc:winBrush faceColor="${fill.ground}" hatchColor="${hashed("ink", design.palette)}" alpha="0"/></hc:fillBrush>`
      : "") +
    "</hh:borderFill>"
  );
}

/** One `charPr`. `id` below 16 is the style bit pattern; above it, a named role. */
function charProperty(id: number, design: DesignProfile): string {
  const heading = id >= HEADING_CHAR_BASE && id < HEADING_CHAR_BASE + 6;
  const quote = id === QUOTE_CHAR;
  const tableHeader = id === TABLE_HEADER_CHAR;
  const named = id >= HEADING_CHAR_BASE;
  const bold =
    heading || tableHeader || id === COVER_TITLE_CHAR || id === ORDINAL_CHAR || (!named && (id & BOLD) !== 0);
  const italic = quote || (!named && (id & ITALIC) !== 0);
  const code = !named && (id & CODE) !== 0;
  const link = !named && (id & LINK) !== 0;
  const height = heading
    ? HEADING_SIZES[id - HEADING_CHAR_BASE]!
    : id === COVER_TITLE_CHAR
      ? centiPoints(DOC.coverTitle)
      : id === SUBTITLE_CHAR
        ? centiPoints(DOC.subtitle)
        : id === ORDINAL_CHAR
          ? centiPoints(DOC.ordinal)
          : code
            ? CODE_SIZE
            : BODY_SIZE;
  const colour = tableHeader
    ? `#${design.table.headerText}`
    : heading
      ? hashed("brand", design.palette)
      : id === ORDINAL_CHAR
        ? hashed("brandLight", design.palette)
        : link
          ? hashed("brandDeep", design.palette)
          : quote || id === SUBTITLE_CHAR || id === TOC_MUTED_CHAR
            ? hashed("inkMuted", design.palette)
            : hashed("ink", design.palette);
  const font = code ? 1 : 0;
  const reference = FONT_LANGUAGES.map(
    (language) => `${language.toLowerCase()}="${font}"`,
  ).join(" ");
  const scale = FONT_LANGUAGES.map((language) => `${language.toLowerCase()}="100"`).join(" ");
  const zero = FONT_LANGUAGES.map((language) => `${language.toLowerCase()}="0"`).join(" ");
  return (
    `<hh:charPr id="${id}" height="${height}" textColor="${colour}" shadeColor="none" ` +
    `useFontSpace="0" useKerning="1" symMark="NONE" borderFillIDRef="${FILL_NONE}">` +
    `<hh:fontRef ${reference}/>` +
    `<hh:ratio ${scale}/><hh:spacing ${zero}/><hh:relSz ${scale}/><hh:offset ${zero}/>` +
    (bold ? "<hh:bold/>" : "") +
    (italic ? "<hh:italic/>" : "") +
    (link
      ? `<hh:underline type="BOTTOM" shape="SOLID" color="${hashed("brandDeep", design.palette)}"/>`
      : "") +
    "</hh:charPr>"
  );
}

function leadingFor(id: number): number {
  if (id === PARA_HEADING) {
    return LEADING.document.heading;
  }
  if (id === PARA_COVER) {
    return LEADING.document.coverTitle;
  }
  if (id === PARA_SUBTITLE) {
    return LEADING.document.subtitle;
  }
  if (
    id === PARA_CODE ||
    id === PARA_TABLE_LEFT ||
    id === PARA_CENTER ||
    id === PARA_RIGHT
  ) {
    return LEADING.document.compact;
  }
  return LEADING.document.body;
}

function paraProperty(id: number, design: DesignProfile): string {
  const indentLevel =
    id >= PARA_INDENT_BASE && id < PARA_INDENT_BASE + PARA_INDENT_LEVELS
      ? id - PARA_INDENT_BASE
      : undefined;
  const heading = id === PARA_HEADING;
  const code = id === PARA_CODE;
  const quote = id === PARA_QUOTE;
  const coverRule = id === PARA_COVER_RULE;
  const cover = id === PARA_COVER;
  const left =
    quote || id === PARA_TOC2
      ? INDENT_STEP
      : indentLevel !== undefined
        ? INDENT_STEP * (indentLevel + 1)
        : 0;
  // A hanging indent on a list item, so a wrapped line lines up under the text
  // rather than under the marker.
  const intent = indentLevel !== undefined ? -INDENT_STEP : 0;
  // The cover's top margin is what drops its title a third down the page —
  // the same composition the DOCX and PDF covers set with their own units.
  const before = heading ? 600 : coverRule ? 20000 : 0;
  const after = code ? 0 : coverRule || cover ? 800 : id === PARA_TOC2 ? 150 : 300;
  const right = coverRule
    ? Math.max(0, TEXT_WIDTH - Math.round(design.doc.coverRulePoints * 100))
    : 0;
  const leading = Math.round(leadingFor(id) * 100);
  const horizontal =
    id === PARA_CENTER
      ? "CENTER"
      : id === PARA_RIGHT
        ? "RIGHT"
        : id === PARA_TABLE_LEFT || coverRule || cover || id === PARA_SUBTITLE
          ? "LEFT"
          : "JUSTIFY";
  return (
    `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" ` +
    'suppressLineNumbers="0" checked="0">' +
    `<hh:align horizontal="${horizontal}" vertical="BASELINE"/>` +
    '<hh:heading type="NONE" idRef="0" level="0"/>' +
    '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" ' +
    `keepWithNext="${heading ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    `<hh:switch><hh:case hh:required-namespace="${NS.app}">` +
    `<hh:margin><hc:intent value="${intent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/>` +
    `<hc:right value="${right}" unit="HWPUNIT"/>` +
    `<hc:prev value="${before}" unit="HWPUNIT"/><hc:next value="${after}" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="${leading}" unit="HWPUNIT"/>` +
    "</hh:case><hh:default>" +
    `<hh:margin><hc:intent value="${intent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/>` +
    `<hc:right value="${right}" unit="HWPUNIT"/>` +
    `<hc:prev value="${before}" unit="HWPUNIT"/><hc:next value="${after}" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="PERCENT" value="${leading}" unit="HWPUNIT"/>` +
    "</hh:default></hh:switch>" +
    // A heading carries a hairline under it — the same signal the DOCX and PDF
    // renderers draw, said in the only way OWPML has: a border fill whose only
    // drawn edge is the bottom one.
    `<hh:border borderFillIDRef="${coverRule ? FILL_COVER_RULE : heading ? FILL_HEADING_RULE : FILL_NONE}" offsetLeft="0" ` +
    'offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>' +
    "</hh:paraPr>"
  );
}

function headerXml(design: DesignProfile): string {
  const fills = fillsFor(design);
  return (
    `<hh:head xmlns:hh="${NS.head}" xmlns:hp="${NS.paragraph}" xmlns:hc="${NS.core}" ` +
    'version="1.31" secCnt="1">' +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    "<hh:refList>" +
    fontfaces() +
    `<hh:borderFills itemCnt="${FILL_COUNT}">` +
    Array.from({ length: FILL_COUNT }, (_, index) => borderFill(index + 1, fills, design)).join("") +
    "</hh:borderFills>" +
    `<hh:charProperties itemCnt="${CHAR_COUNT}">` +
    Array.from({ length: CHAR_COUNT }, (_, id) => charProperty(id, design)).join("") +
    "</hh:charProperties>" +
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
    '<hh:numberings itemCnt="0"/>' +
    `<hh:paraProperties itemCnt="${PARA_COUNT}">` +
    Array.from({ length: PARA_COUNT }, (_, id) => paraProperty(id, design)).join("") +
    "</hh:paraProperties>" +
    '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" ' +
    'paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
    "</hh:refList></hh:head>"
  );
}

/* -------------------------------------------------------------------- body */

/**
 * The section properties, which belong inside the first run of the first
 * paragraph.
 *
 * **No page number here, unlike the DOCX and PDF renderers.** OWPML puts a
 * footer in a `hp:footer` control with its own sub-list and a `hp:pageNum`
 * inside it, anchored to the section — a shape this file would have to get right
 * against one reader that either opens a file or does not. The other two formats
 * have many forgiving implementations and a one-element field; this one has
 * neither, and a numbered page is not worth a document 한글 refuses to open.
 */
function sectionProperties(design: DesignProfile): string {
  return (
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" ' +
    'tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" ' +
    'textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0" strtnum="0"/>' +
    '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" ' +
    'border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" ' +
    'showLineNumber="0"/>' +
    `<hp:pagePr landscape="WIDELY" width="${PAGE.width}" height="${PAGE.height}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${MARGIN.header}" footer="${MARGIN.footer}" gutter="0" left="${MARGIN.left}" ` +
    `right="${MARGIN.right}" top="${MARGIN.top}" bottom="${MARGIN.bottom}"/></hp:pagePr>` +
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
    `<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="${hashed("ink", design.palette)}"/>` +
    '<hp:noteSpacing betweenNotes="850" belowLine="567" aboveLine="850"/>' +
    '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/>' +
    "</hp:footNotePr>" +
    '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>' +
    `<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="${hashed("ink", design.palette)}"/>` +
    '<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>' +
    '<hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/>' +
    "</hp:endNotePr>" +
    '<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" ' +
    'footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/>' +
    "</hp:pageBorderFill>" +
    "</hp:secPr>"
  );
}

/**
 * Characters that take a full em; everything else is counted as half.
 *
 * The same approximation the PPTX renderer packs slides with, restated here
 * because the two units differ — a glyph at `size` centi-points is about
 * `size` HWPUNIT wide, which is what makes the arithmetic below one line.
 */
const WIDE =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-｠￠-￦]/;

/**
 * How much of the stated width the estimator lets a line claim.
 *
 * The half-width approximation runs a few percent narrow of 함초롬바탕's real
 * metrics — bold runs, an em dash counted as half — and a paragraph estimated
 * onto one line that 한글 wraps onto two is the shape its checker flags as
 * depending on non-standard reflow. Under-claiming nudges the boundary the
 * cheaper way: a break a little early is a slightly short line, a break that
 * never came is a warning dialog.
 */
const LINESEG_SAFETY = 0.92;

/**
 * The longest text rhwp accepts on a single lineseg, and where to break when
 * a paragraph has to be split for it rather than for width.
 *
 * The rule is read straight from the reader it serves: rhwp (the engine
 * behind the hop viewer) flags `line_segs.len() == 1 && !text.contains('\n')
 * && chars > 40` as `LinesegTextRunReflow` — a fixed character count with no
 * width in it (`document_core/commands/document.rs`, `LONG_TEXT_THRESHOLD`).
 * A 42-character Latin line that fits one line in every honest metric still
 * trips it, which is why no amount of width tuning ever cleared the warning.
 * The break lands at the last space before the limit so both halves read as
 * lines; rhwp's own layout assumes ~30 Korean characters to a line, so a
 * split it forced is one its renderer expected anyway.
 */
const SINGLE_LINESEG_LIMIT = 40;
const FORCED_BREAK_AT = 36;

/**
 * The line layout, one `lineseg` per estimated line.
 *
 * **The estimate has to be honest, not pessimistic — the readers draw what
 * this says.** That was learned the expensive way, in both directions. A
 * wrapped paragraph carrying a single lineseg renders (readers fall back to
 * their own reflow for the degenerate shape) but is flagged as depending on
 * it. So one revision assumed the worst metric imaginable — every character a
 * full em — on the theory that spare linesegs would be silently recomputed.
 * They are not: multi-lineseg data is *trusted*, the fabricated break
 * positions were drawn as written, and every long paragraph rendered broken
 * at half width. The count and the breaks below are therefore the closest
 * per-script estimate available, nudged slightly conservative by
 * `LINESEG_SAFETY` — plus the one non-negotiable contract above, imposed by
 * the reader rather than by geometry.
 */
function lineSegments(text: string, size: number, width: number, leading: number): string {
  const lineHeight = Math.round(size * leading);
  const usable = Math.max(size, width * LINESEG_SAFETY);
  // UTF-16 offsets, which is what `textpos` counts.
  const starts: number[] = [0];
  let used = 0;
  let characters = 0;
  for (let index = 0; index < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(index)!);
    characters += 1;
    const advance = character === "\t" ? size * 2 : WIDE.test(character) ? size : size / 2;
    if (used + advance > usable && used > 0) {
      starts.push(index);
      used = 0;
    }
    used += advance;
    index += character.length;
  }
  if (starts.length === 1 && characters > SINGLE_LINESEG_LIMIT) {
    // Width said one line; the reader's contract says a paragraph this long
    // must not claim it. Break at a word boundary near the limit.
    const space = text.lastIndexOf(" ", FORCED_BREAK_AT);
    const split = space > 4 ? space + 1 : FORCED_BREAK_AT;
    const unit = text.charCodeAt(split);
    starts.push(unit >= 0xdc00 && unit <= 0xdfff ? split - 1 : split);
  }
  return (
    "<hp:linesegarray>" +
    starts
      .map(
        (textpos, line) =>
          `<hp:lineseg textpos="${textpos}" vertpos="${line * lineHeight}" ` +
          `vertsize="${size}" textheight="${size}" baseline="${Math.round(size * 0.85)}" ` +
          `spacing="${Math.round(size * 0.6)}" horzpos="0" horzsize="${width}" flags="393216"/>`,
      )
      .join("") +
    "</hp:linesegarray>"
  );
}

class Renderer {
  private paragraphId = 0;
  /** The section properties ride in the first run written, wherever that is. */
  private sectionEmitted = false;
  /** The next paragraph opens a fresh page — how a cover or a chapter ends. */
  private breakNext = false;

  constructor(private readonly design: DesignProfile = designFor()) {}

  /** Ask for a page break before whatever paragraph comes next. */
  breakBeforeNext(): void {
    this.breakNext = true;
  }

  private runs(runs: readonly Run[], forcedCharId?: number): string {
    if (runs.length === 0) {
      return this.run("", forcedCharId ?? 0, "");
    }
    return runs
      .map((run) => this.run(run.text, forcedCharId ?? charIdOf(run), ""))
      .join("");
  }

  /** One `hp:run`. Tabs become the element HWPX uses for them, not a character. */
  private run(text: string, charId: number, extra: string): string {
    const prefix = this.sectionEmitted ? "" : sectionProperties(this.design);
    this.sectionEmitted = true;
    const body = text
      .split("\t")
      .map((piece) => `<hp:t>${escapeXml(piece)}</hp:t>`)
      .join('<hp:ctrl><hp:tab width="4000" leader="NONE" type="LEFT"/></hp:ctrl>');
    return `<hp:run charPrIDRef="${charId}">${prefix}${extra}${body}</hp:run>`;
  }

  private paragraph(
    inner: string,
    paraId: number,
    size = BODY_SIZE,
    text = "",
    width = TEXT_WIDTH,
  ): string {
    const id = this.paragraphId;
    this.paragraphId += 1;
    // `pageBreak` is the paragraph attribute 한글 itself writes for "this
    // paragraph starts a page" — one flag on an element already in use, which
    // is the only kind of novelty this format affords.
    const pageBreak = this.breakNext ? 1 : 0;
    this.breakNext = false;
    return (
      `<hp:p id="${id}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${pageBreak}" columnBreak="0" merged="0">` +
      inner +
      lineSegments(text, size, width, leadingFor(paraId)) +
      "</hp:p>"
    );
  }

  private table(block: Extract<Block, { kind: "table" }>): string {
    // Reserve document-level state for the containing paragraph before building cells.
    const section = this.sectionEmitted ? "" : sectionProperties(this.design);
    this.sectionEmitted = true;
    const breakBefore = this.breakNext;
    this.breakNext = false;
    const rows = [block.header, ...block.rows];
    const columns = Math.max(1, ...rows.map((row) => row.length));
    const widths = columnShares(rows, columns).map((share) => Math.round(share * TEXT_WIDTH));
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const rowHeight = 2400;
    const cell = (cells: readonly Run[][], column: number, row: number): string => {
      const header = row === 0;
      const runs = cells[column] ?? [];
      // The cell's paragraph is a `hp:p` of its own inside a `hp:subList`; a
      // cell with no paragraph is what makes 한글 refuse the file.
      const align = block.align[column];
      const inner = this.paragraph(
        this.runs(runs, header ? TABLE_HEADER_CHAR : undefined),
        align === "right" ? PARA_RIGHT : align === "center" ? PARA_CENTER : PARA_TABLE_LEFT,
        BODY_SIZE,
        plainOf(runs),
        // The text area, not the cell: the margins written into `cellMargin`
        // below take 510 a side, and estimating against the full cell width is
        // how a cell's last word wrapped in 한글 but not in the lineseg count.
        Math.max(BODY_SIZE, widths[column]! - 1020),
      );
      // Zebra counted from the header, so the first data row is the plain one —
      // a tint straight under a filled header reads as a two-row header.
      const fill = header ? FILL_HEADER : row % 2 === 0 ? FILL_ZEBRA : FILL_CELL;
      return (
        `<hp:tc name="" header="${header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" ` +
        `borderFillIDRef="${fill}">` +
        '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" ' +
        'linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
        inner +
        "</hp:subList>" +
        `<hp:cellAddr colAddr="${column}" rowAddr="${row}"/>` +
        '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
        `<hp:cellSz width="${widths[column]}" height="${rowHeight}"/>` +
        '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>' +
        "</hp:tc>"
      );
    };
    const body = rows
      .map(
        (cells, row) =>
          `<hp:tr>${Array.from({ length: columns }, (_, column) => cell(cells, column, row)).join("")}</hp:tr>`,
      )
      .join("");
    const table =
      `<hp:tbl id="${1_000 + this.paragraphId}" zOrder="0" numberingType="TABLE" ` +
      'textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ' +
      `pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${columns}" ` +
      `cellSpacing="0" borderFillIDRef="${FILL_NONE}" noAdjust="0">` +
      `<hp:sz width="${tableWidth}" widthRelTo="ABSOLUTE" height="${rowHeight * rows.length}" ` +
      'heightRelTo="ABSOLUTE" protect="0"/>' +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" ' +
      'holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" ' +
      'vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="283"/>' +
      '<hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
      body +
      "</hp:tbl>";
    // A table is an object inside a run, which is inside a paragraph of its own.
    this.breakNext = breakBefore;
    return this.paragraph(this.run("", 0, section + table), PARA_BODY);
  }

  block(block: Block): string {
    switch (block.kind) {
      case "heading":
        return this.paragraph(
          this.runs(block.runs, HEADING_CHAR_BASE + block.level - 1),
          PARA_HEADING,
          HEADING_SIZES[block.level - 1]!,
          plainOf(block.runs),
        );
      case "paragraph":
        return this.paragraph(this.runs(block.runs), PARA_BODY, BODY_SIZE, plainOf(block.runs));
      case "list": {
        const counters: number[] = [];
        return block.items
          .map((item) => {
            counters.length = item.depth + 1;
            counters[item.depth] = (counters[item.depth] ?? 0) + 1;
            const marker = block.ordered ? `${counters[item.depth]}. ` : "- ";
            const depth = Math.min(item.depth, PARA_INDENT_LEVELS - 1);
            return this.paragraph(
              this.runs([{ text: marker }, ...item.runs]),
              PARA_INDENT_BASE + depth,
              BODY_SIZE,
              marker + plainOf(item.runs),
              TEXT_WIDTH - INDENT_STEP * (depth + 1),
            );
          })
          .join("");
      }
      case "code":
        return (block.text === "" ? [""] : block.text.split("\n"))
          .map((line) =>
            this.paragraph(this.runs([{ text: line, code: true }]), PARA_CODE, CODE_SIZE, line),
          )
          .join("");
      case "quote":
        return this.paragraph(
          this.runs(block.runs, QUOTE_CHAR),
          PARA_QUOTE,
          BODY_SIZE,
          plainOf(block.runs),
          TEXT_WIDTH - INDENT_STEP,
        );
      case "table":
        return this.table(block);
      case "directive":
        // A directive is a PPTX planning hint; on a page its contents stand
        // where it stood.
        return block.blocks.map((inner) => this.block(inner)).join("");
      case "rule":
        // OWPML's horizontal rule is a control object; a row of dashes is the
        // same mark on the page with none of the ways that can go wrong.
        return this.paragraph(
          this.runs([{ text: "─".repeat(40) }]),
          PARA_BODY,
          BODY_SIZE,
          "─".repeat(40),
        );
    }
  }

  /**
   * The cover: a short profile rule drops a third down the page, then the title
   * and subtitle follow with role-specific leading. A paragraph border is used
   * rather than a drawing control, keeping the package inside the small OWPML
   * surface this renderer can validate.
   */
  cover(cover: Cover): string {
    const rule = this.paragraph(this.runs([]), PARA_COVER_RULE, BODY_SIZE, "");
    const title = this.paragraph(
      this.runs(cover.title, COVER_TITLE_CHAR),
      PARA_COVER,
      centiPoints(DOC.coverTitle),
      plainOf(cover.title),
    );
    const subtitle = cover.subtitle
      ? this.paragraph(
          this.runs(cover.subtitle, SUBTITLE_CHAR),
          PARA_SUBTITLE,
          centiPoints(DOC.subtitle),
          plainOf(cover.subtitle),
        )
      : "";
    this.breakBeforeNext();
    return rule + title + subtitle;
  }

  /**
   * The contents: a heading-styled label and one line per entry, numbers
   * omitted — this renderer does not paginate, so the honest list is the one
   * without them, exactly as the DOCX contents decided.
   */
  toc(label: string, entries: readonly { runs: Run[]; level: number }[]): string {
    const head = this.paragraph(
      this.runs([{ text: label }], HEADING_CHAR_BASE),
      PARA_HEADING,
      HEADING_SIZES[0]!,
      label,
    );
    const rows = entries
      .map((entry) =>
        entry.level === 1
          ? this.paragraph(this.runs(entry.runs, BOLD), PARA_BODY, BODY_SIZE, plainOf(entry.runs))
          : this.paragraph(
              this.runs(entry.runs, TOC_MUTED_CHAR),
              PARA_TOC2,
              BODY_SIZE,
              plainOf(entry.runs),
              TEXT_WIDTH - INDENT_STEP,
            ),
      )
      .join("");
    this.breakBeforeNext();
    return head + rows;
  }

  /** A chapter's ordinal, opening a fresh page unless nothing is on this one. */
  chapterOpener(ordinal: number, breakBefore: boolean): string {
    if (breakBefore) {
      this.breakBeforeNext();
    }
    const label = String(ordinal).padStart(2, "0");
    return this.paragraph(
      this.runs([{ text: label }], ORDINAL_CHAR),
      PARA_BODY,
      centiPoints(DOC.ordinal),
      label,
    );
  }

  /** True once something has carried the section properties. */
  hasSection(): boolean {
    return this.sectionEmitted;
  }

  /** An empty document still needs one paragraph to hang the section on. */
  emptyParagraph(): string {
    return this.paragraph(this.runs([]), PARA_BODY);
  }
}

function sectionXml(document: MarkdownDocument, design: DesignProfile): string {
  const renderer = new Renderer(design);
  const { cover, body } = coverOf(document.blocks);
  const entries = tocEntriesOf(body);
  let out = cover ? renderer.cover(cover) : "";
  if (cover && entries.length >= TOC_THRESHOLD) {
    out += renderer.toc(HANGUL.test(plainOf(cover.title)) ? "목차" : "Contents", entries);
  }
  let ordinal = 0;
  let rendered = cover !== undefined;
  for (const block of body) {
    if (block.kind === "heading" && block.level === 1) {
      ordinal += 1;
      out += renderer.chapterOpener(ordinal, rendered);
    }
    out += renderer.block(block);
    rendered = true;
  }
  return (
    `<hs:sec xmlns:hs="${NS.section}" xmlns:hp="${NS.paragraph}" xmlns:hc="${NS.core}" ` +
    `xmlns:hh="${NS.head}">` +
    (renderer.hasSection() ? out : out + renderer.emptyParagraph()) +
    "</hs:sec>"
  );
}

/* --------------------------------------------------------------- packaging */

function versionXml(): string {
  // `tagetApplication` is spelled that way in the format itself. OWPML keeps the
  // producer's name and its version in separate attributes, which is why this is
  // the one format that does not take `PRODUCER` whole.
  return (
    `<hv:HCFVersion xmlns:hv="${NS.version}" tagetApplication="WORDPROCESSOR" major="5" minor="1" ` +
    `micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="${escapeXml(SERVER_NAME)}" ` +
    `appVersion="${escapeXml(SERVER_VERSION)}"/>`
  );
}

function containerXml(): string {
  return (
    `<ocf:container xmlns:ocf="${NS.ocf}" xmlns="${NS.opf}"><ocf:rootfiles>` +
    '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
    "</ocf:rootfiles></ocf:container>"
  );
}

const MANIFEST_PARTS = [
  "version.xml",
  "settings.xml",
  "Contents/content.hpf",
  "Contents/header.xml",
  "Contents/section0.xml",
];

function manifestXml(): string {
  return (
    `<odf:manifest xmlns:odf="${NS.manifest}" odf:version="1.2">` +
    '<odf:file-entry odf:full-path="/" odf:media-type="application/hwp+zip"/>' +
    MANIFEST_PARTS.map(
      (path) => `<odf:file-entry odf:full-path="${path}" odf:media-type="text/xml"/>`,
    ).join("") +
    "</odf:manifest>"
  );
}

function contentHpf(title: string, created: string): string {
  return (
    `<opf:package xmlns:opf="${NS.opf}" xmlns:ha="${NS.app}" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    'version="" unique-identifier="" id="">' +
    "<opf:metadata>" +
    `<opf:title>${escapeXml(title)}</opf:title>` +
    "<opf:language>ko</opf:language>" +
    `<opf:meta name="creator" content="${escapeXml(PRODUCER)}"/>` +
    `<opf:meta name="CreatedDate" content="${escapeXml(created)}"/>` +
    "</opf:metadata>" +
    "<opf:manifest>" +
    '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
    '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
    '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>' +
    "</opf:manifest>" +
    '<opf:spine><opf:itemref idref="header" linear="yes"/>' +
    '<opf:itemref idref="section0" linear="yes"/></opf:spine>' +
    "</opf:package>"
  );
}

function settingsXml(): string {
  return (
    `<ha:HWPApplicationSetting xmlns:ha="${NS.app}" ` +
    'xmlns:config="http://www.hancom.co.kr/hwpml/2011/configItemSet">' +
    '<config:config-item-set name="CaretHistory">' +
    '<config:config-item name="listIDRef" type="string">0</config:config-item>' +
    '<config:config-item name="paraIDRef" type="string">0</config:config-item>' +
    '<config:config-item name="pos" type="string">0</config:config-item>' +
    "</config:config-item-set></ha:HWPApplicationSetting>"
  );
}

export interface HwpxOptions {
  title: string;
  /** ISO 8601, passed in so the bytes are a function of the input alone. */
  created: string;
  profile?: DocumentProfile;
}

export function renderHwpx(document: MarkdownDocument, options: HwpxOptions): Uint8Array {
  const design = designFor(options.profile);
  return buildZip({
    // First, and stored rather than deflated: the same rule ODF packaging uses,
    // and a reader that checks for it checks at a fixed offset.
    mimetype: stored(encoder.encode("application/hwp+zip")),
    "version.xml": part(versionXml()),
    "settings.xml": part(settingsXml()),
    "META-INF/container.xml": part(containerXml()),
    "META-INF/manifest.xml": part(manifestXml()),
    "Contents/content.hpf": part(contentHpf(options.title, options.created)),
    "Contents/header.xml": part(headerXml(design)),
    "Contents/section0.xml": part(sectionXml(document, design)),
  });
}
