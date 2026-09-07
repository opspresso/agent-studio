/**
 * The parts of a PPTX that are not slides.
 *
 * A deck needs more scaffolding than a document — PowerPoint refuses a file
 * with no theme or no slide master — so the master, the layouts and the theme
 * are fixed constants here, and only the slides are a function of the input.
 * All of the "empty" parts (presProps, viewProps, tableStyles) are carried
 * because their absence is a package shape no native file has ever had, and
 * Windows PowerPoint reads absence as damage where the Mac build shrugs.
 */

import { escapeXml } from "../../xml";
import { HANGUL } from "../semantics";
import {
  DECK,
  LEADING,
  TYPOGRAPHY,
  centiPoints,
  emu,
  type DesignProfile,
} from "../theme";
import { PRODUCER } from "../../version";
import {
  BODY_BOX,
  BODY_SIZE,
  CLOSING_BODY_BOX,
  CLOSING_TITLE_BOX,
  CONTENT_WIDTH,
  COVER_TITLE_BOX,
  HEAD_RULE,
  HEAD_RULE_GAP,
  NUMBER_BOX,
  SECTION_TITLE_BOX,
  SIDE_MARGIN,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  SUBTITLE_BOX,
  TITLE_BOX,
  TITLE_SIZE,
} from "./layout";
import {
  A,
  HYPERLINK_TYPE,
  IMAGE_TYPE,
  P,
  R,
  RELATIONSHIPS,
  SLIDE_LAYOUT_TYPE,
  SLIDE_MASTER_TYPE,
  SLIDE_TYPE,
  TABLE_STYLE_ID,
  THEME_TYPE,
  relationship,
  relationships,
} from "./ooxml";

/**
 * The four layouts, in part order: a slide names its archetype's layout, and
 * PowerPoint's "New Slide" gallery offers the same four back to the reader.
 * Cover and content keep parts 1 and 2, which is where every earlier release
 * put them.
 */
export const LAYOUT_COUNT = 4;

export type LayoutIndex = 1 | 2 | 3 | 4;

/** The media types a `<Default>` can carry, keyed by the extension it names. */
const MEDIA_DEFAULTS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
};

export function contentTypesXml(slides: number, mediaExtensions: readonly string[] = []): string {
  const override = (path: string, type: string): string =>
    `<Override PartName="${path}" ContentType="${type}"/>`;
  const presentationml = "application/vnd.openxmlformats-officedocument.presentationml";
  return (
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    mediaExtensions
      .map((extension) => `<Default Extension="${extension}" ContentType="${MEDIA_DEFAULTS[extension]}"/>`)
      .join("") +
    override("/ppt/presentation.xml", `${presentationml}.presentation.main+xml`) +
    override("/ppt/slideMasters/slideMaster1.xml", `${presentationml}.slideMaster+xml`) +
    Array.from({ length: LAYOUT_COUNT }, (_, index) =>
      override(`/ppt/slideLayouts/slideLayout${index + 1}.xml`, `${presentationml}.slideLayout+xml`),
    ).join("") +
    Array.from({ length: slides }, (_, index) =>
      override(`/ppt/slides/slide${index + 1}.xml`, `${presentationml}.slide+xml`),
    ).join("") +
    override(
      "/ppt/theme/theme1.xml",
      "application/vnd.openxmlformats-officedocument.theme+xml",
    ) +
    override("/ppt/presProps.xml", `${presentationml}.presProps+xml`) +
    override("/ppt/viewProps.xml", `${presentationml}.viewProps+xml`) +
    override("/ppt/tableStyles.xml", `${presentationml}.tableStyles+xml`) +
    override(
      "/docProps/core.xml",
      "application/vnd.openxmlformats-package.core-properties+xml",
    ) +
    override(
      "/docProps/app.xml",
      "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    ) +
    "</Types>"
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
export function appPropertiesXml(): string {
  return (
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>${escapeXml(PRODUCER)}</Application>` +
    "</Properties>"
  );
}

export function packageRelsXml(): string {
  return relationships([
    relationship("rId1", `${R}/officeDocument`, "ppt/presentation.xml"),
    relationship("rId2", `${RELATIONSHIPS}/metadata/core-properties`, "docProps/core.xml"),
    relationship("rId3", `${R}/extended-properties`, "docProps/app.xml"),
  ]);
}

export function corePropertiesXml(title: string, created: string): string {
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

export function presPropsXml(): string {
  return `<p:presentationPr xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"/>`;
}

export function viewPropsXml(): string {
  return `<p:viewPr xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"/>`;
}

export function tableStylesXml(): string {
  return `<a:tblStyleLst xmlns:a="${A}" def="${TABLE_STYLE_ID}"/>`;
}

export function presentationXml(slides: number): string {
  return (
    `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    "<p:sldIdLst>" +
    // Slide ids start at 256, which the format requires, and the relationship
    // ids continue past the master's rId1.
    Array.from(
      { length: slides },
      (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`,
    ).join("") +
    "</p:sldIdLst>" +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    "</p:presentation>"
  );
}

export function presentationRelsXml(slides: number): string {
  // The theme is reachable through the master, but native files relate it from
  // the presentation part as well, and the other three live only here.
  const next = slides + 2;
  return relationships([
    relationship("rId1", SLIDE_MASTER_TYPE, "slideMasters/slideMaster1.xml"),
    ...Array.from({ length: slides }, (_, index) =>
      relationship(`rId${index + 2}`, SLIDE_TYPE, `slides/slide${index + 1}.xml`),
    ),
    relationship(`rId${next}`, THEME_TYPE, "theme/theme1.xml"),
    relationship(`rId${next + 1}`, `${R}/presProps`, "presProps.xml"),
    relationship(`rId${next + 2}`, `${R}/viewProps`, "viewProps.xml"),
    relationship(`rId${next + 3}`, `${R}/tableStyles`, "tableStyles.xml"),
  ]);
}

/**
 * The theme, which is not optional.
 *
 * PowerPoint refuses a package whose master has no theme behind it, and the
 * schema wants three entries in each of the four format lists whether or not
 * anything refers to them. No east-Asian face is named, for the reason
 * `write/docx.ts` names none: the substitute PowerPoint picks on the reader's
 * machine beats one picked here from a font that may not be installed.
 */
export function themeXml(design: DesignProfile): string {
  const accents = design.chart.slice(0, 6);
  const { palette } = design;
  const line = (width: number): string =>
    `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">` +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return (
    `<a:theme xmlns:a="${A}" name="Office">` +
    "<a:themeElements>" +
    '<a:clrScheme name="Office">' +
    `<a:dk1><a:sysClr val="windowText" lastClr="${palette.ink}"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="${palette.onBrand}"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="${palette.brand}"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="${palette.brandTint}"/></a:lt2>` +
    accents
      .map((colour, index) => `<a:accent${index + 1}><a:srgbClr val="${colour}"/></a:accent${index + 1}>`)
      .join("") +
    `<a:hlink><a:srgbClr val="${palette.brandDeep}"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="${palette.brandDeep}"/></a:folHlink>` +
    "</a:clrScheme>" +
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    "</a:fontScheme>" +
    '<a:fmtScheme name="Office">' +
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3) +
    "</a:effectStyleLst>" +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    "</a:fmtScheme>" +
    "</a:themeElements>" +
    "</a:theme>"
  );
}

/** An empty placeholder in a layout, which the slide's own shape inherits its slot from. */
function layoutPlaceholder(id: number, name: string, placeholder: string, box: { y: number; height: number }): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${SIDE_MARGIN}" y="${box.y}"/>` +
    `<a:ext cx="${CONTENT_WIDTH}" cy="${box.height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>' +
    '<a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>'
  );
}

/**
 * A filled rectangle with nothing to say — a band, a rule, a ground.
 *
 * These live on layouts, never on slides: PowerPoint renders a layout's shapes
 * under the slide's, a reader editing the deck cannot select them by accident,
 * and this server's own text extractor never sees them, because it reads only
 * `ppt/slides/*`. That is exactly where a template keeps its furniture.
 */
function decorRect(
  id: number,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  colour: string,
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
    `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>` +
    "</p:spPr>" +
    // Mandatory in practice, whatever the schema says: a p:sp without a txBody
    // is a shape PowerPoint offers to repair.
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>' +
    "</p:sp>"
  );
}

/** A static line of layout text — the footer that names the deck on every content slide. */
function decorText(
  id: number,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  text: string,
  design: DesignProfile,
): string {
  // The same language labelling the slides' runs carry, for the same reason:
  // an unlabelled 한글 footer is set in the reader's locale's CJK face.
  const lang = HANGUL.test(text) ? "ko-KR" : "en-US";
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
    `<a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>' +
    `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="${lang}" sz="${centiPoints(DECK.caption)}" dirty="0">` +
    `<a:solidFill><a:srgbClr val="${design.palette.inkMuted}"/></a:solidFill></a:rPr>` +
    `<a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** `p:bg` for the layouts whose ground is part of the design. */
function background(colour: string): string {
  return (
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill>` +
    "<a:effectLst/></p:bgPr></p:bg>"
  );
}

/** The accent rule a cover or divider carries above its title. */
function headRule(id: number, x: number, titleY: number, colour: string): string {
  return decorRect(
    id,
    `Rule ${id}`,
    { x, y: titleY - HEAD_RULE_GAP - HEAD_RULE.height, width: HEAD_RULE.width, height: HEAD_RULE.height },
    colour,
  );
}

/**
 * One slide layout, `1` to `LAYOUT_COUNT`.
 *
 * The design of each archetype lives here rather than on its slides: the
 * cover's tinted ground and brand band, the section divider's brand field,
 * the content footer that names the deck. `deckTitle` is what that footer says.
 */
export function slideLayoutXml(
  index: LayoutIndex,
  deckTitle: string,
  design: DesignProfile,
): string {
  const { palette } = design;
  const wrap = (
    type: string,
    name: string,
    bg: string | undefined,
    shapes: readonly string[],
  ): string =>
    `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" ` +
    `type="${type}" preserve="1">` +
    `<p:cSld name="${name}">${bg ?? ""}<p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join("") +
    "</p:spTree></p:cSld>" +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

  switch (index) {
    case 1:
      // The cover: the quiet tinted ground, a brand band down the left edge, a
      // rule above where the title lands.
      return wrap("title", "Cover", background(palette.surfaceTint), [
        ...(design.deck.coverBandPoints > 0
          ? [
              decorRect(
                2,
                "Band",
                { x: 0, y: 0, width: emu(design.deck.coverBandPoints), height: SLIDE_HEIGHT },
                palette.brand,
              ),
            ]
          : []),
        headRule(3, SIDE_MARGIN, COVER_TITLE_BOX.y, palette.brand),
        layoutPlaceholder(4, "Title 1", '<p:ph type="title"/>', COVER_TITLE_BOX),
        layoutPlaceholder(5, "Subtitle 2", '<p:ph type="body" idx="1"/>', SUBTITLE_BOX),
      ]);
    case 2:
      // Content: white ground, the deck's name quietly in the footer. The
      // accent bar under the title stays on the slide, which knows whether
      // there is a title to underline.
      return wrap("obj", "Title and Content", undefined, [
        decorText(
          2,
          "Footer",
          {
            x: SIDE_MARGIN,
            y: SLIDE_HEIGHT - SIDE_MARGIN,
            width: Math.floor(CONTENT_WIDTH / 2),
            height: NUMBER_BOX.height,
          },
          deckTitle,
          design,
        ),
        layoutPlaceholder(3, "Title 1", '<p:ph type="title"/>', TITLE_BOX),
        layoutPlaceholder(4, "Body 2", '<p:ph type="body" idx="1"/>', BODY_BOX),
      ]);
    case 3:
      // A section divider: a full brand field, the rule in the lighter brand
      // above the title. The ordinal is content and comes with the slide.
      return wrap("secHead", "Section", background(palette.brand), [
        headRule(2, SIDE_MARGIN, SECTION_TITLE_BOX.y, palette.brandLight),
        layoutPlaceholder(3, "Title 1", '<p:ph type="title"/>', SECTION_TITLE_BOX),
      ]);
    case 4:
      // The closing: the cover's ground, and a centred rule above the line.
      return wrap("cust", "Closing", background(palette.surfaceTint), [
        headRule(
          2,
          Math.round((SLIDE_WIDTH - HEAD_RULE.width) / 2),
          CLOSING_TITLE_BOX.y,
          palette.brand,
        ),
        layoutPlaceholder(3, "Title 1", '<p:ph type="title"/>', CLOSING_TITLE_BOX),
        layoutPlaceholder(4, "Body 2", '<p:ph type="body" idx="1"/>', CLOSING_BODY_BOX),
      ]);
  }
}

export function slideLayoutRelsXml(): string {
  return relationships([
    relationship("rId1", SLIDE_MASTER_TYPE, "../slideMasters/slideMaster1.xml"),
  ]);
}

export function slideMasterXml(design: DesignProfile): string {
  const style = (size: number): string =>
    `<a:lvl1pPr><a:lnSpc><a:spcPct val="${Math.round(LEADING.deck.body * 100000)}"/></a:lnSpc>` +
    `<a:defRPr sz="${size}" kern="${centiPoints(TYPOGRAPHY.kerningFromPoints)}" spc="${TYPOGRAPHY.tracking}">` +
    `<a:solidFill><a:srgbClr val="${design.palette.ink}"/></a:solidFill>` +
    "</a:defRPr></a:lvl1pPr>";
  return (
    `<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill>' +
    "<a:effectLst/></p:bgPr></p:bg><p:spTree>" +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    // The top of the inheritance chain. A slide's placeholder points at its
    // layout's, and the layout's at these — native masters always carry them,
    // and a chain that ends nowhere is another shape no real file has.
    layoutPlaceholder(2, "Title Placeholder 1", '<p:ph type="title"/>', TITLE_BOX) +
    layoutPlaceholder(3, "Body Placeholder 2", '<p:ph type="body" idx="1"/>', BODY_BOX) +
    "</p:spTree></p:cSld>" +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" ' +
    'folHlink="folHlink"/>' +
    "<p:sldLayoutIdLst>" +
    Array.from(
      { length: LAYOUT_COUNT },
      (_, index) => `<p:sldLayoutId id="${2147483649 + index}" r:id="rId${index + 1}"/>`,
    ).join("") +
    "</p:sldLayoutIdLst>" +
    `<p:txStyles><p:titleStyle>${style(TITLE_SIZE)}</p:titleStyle>` +
    `<p:bodyStyle>${style(BODY_SIZE)}</p:bodyStyle>` +
    `<p:otherStyle>${style(BODY_SIZE)}</p:otherStyle></p:txStyles>` +
    "</p:sldMaster>"
  );
}

export function slideMasterRelsXml(): string {
  return relationships([
    ...Array.from({ length: LAYOUT_COUNT }, (_, index) =>
      relationship(`rId${index + 1}`, SLIDE_LAYOUT_TYPE, `../slideLayouts/slideLayout${index + 1}.xml`),
    ),
    relationship(`rId${LAYOUT_COUNT + 1}`, THEME_TYPE, "../theme/theme1.xml"),
  ]);
}

export function slideRelsXml(
  layout: LayoutIndex,
  rels: readonly { kind: "hyperlink" | "image"; target: string }[],
): string {
  return relationships([
    relationship("rId1", SLIDE_LAYOUT_TYPE, `../slideLayouts/slideLayout${layout}.xml`),
    ...rels.map((rel, index) =>
      rel.kind === "hyperlink"
        ? relationship(`rId${index + 2}`, HYPERLINK_TYPE, rel.target, true)
        : relationship(`rId${index + 2}`, IMAGE_TYPE, rel.target),
    ),
  ]);
}
