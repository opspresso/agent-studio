/**
 * The one place a colour, size or spacing is decided.
 *
 * The four renderers read the same tokens so a profile retains its hierarchy,
 * rhythm and contrast when the delivery format changes.
 *
 * **The profiles are deliberately nobody's brand.** A document handed to a
 * customer, a partner or a public office should not arrive dressed in its
 * tooling's colours. Each profile instead makes a small set of editorial
 * decisions for a specific reading context: restrained blues and teals for
 * structure, neutral near-black ink, quiet grey rules, and geometry that
 * ranges from formal to presentation-led. The result should look designed and
 * belong to no one.
 *
 * What that means concretely:
 *
 * - *White pages.* A tinted ground is kept for the two surfaces that can carry
 *   a full-bleed field for free — a cover slide, a section divider — and body
 *   pages stay white: a tint under a whole document is ink somebody pays for
 *   and an artefact in every photocopy.
 * - *No decoration for its own sake.* The identity is hierarchy, spacing and
 *   a few hairlines; every colour below earns a WCAG ratio in `theme.test.ts`
 *   or it does not ship.
 * - *Pure black is still never used* — near-black reads as ink, full black on
 *   a screen glares.
 *
 * **No font is named, in any format.** `write/docx.ts` reached this conclusion
 * on its own — a face named here is a face the reader's machine may not have,
 * and the substitute is then chosen by nobody. The identity is carried by
 * colour and layout, which survive every substitution. The PDF is the
 * exception it always was: it embeds Nanum Gothic because PDF has no system
 * stack to fall back to.
 */

/* --------------------------------------------------------------- palette */

/**
 * Six-digit hex, no `#`.
 *
 * DOCX and PPTX want it exactly like this, HWPX wants a `#` in front, and the
 * PDF wants three floats — `hashed` and `rgbOf` below do those two conversions
 * so the values themselves are stated once.
 */
export const DOCUMENT_PROFILES = [
  "executive",
  "consulting",
  "formal",
  "technical",
  "standard",
] as const;

export type DocumentProfile = (typeof DOCUMENT_PROFILES)[number];

export const DEFAULT_PROFILE: DocumentProfile = "executive";

export interface Palette {
  readonly brand: string;
  readonly brandLight: string;
  readonly brandDeep: string;
  readonly brandTint: string;
  readonly surfaceTint: string;
  readonly ink: string;
  readonly inkMuted: string;
  readonly rule: string;
  readonly onBrand: string;
  readonly positive: string;
  readonly negative: string;
}

export interface DesignProfile {
  readonly profile: DocumentProfile;
  readonly label: string;
  readonly description: string;
  readonly palette: Palette;
  readonly chart: readonly string[];
  readonly table: {
    readonly headerFill: string;
    readonly headerText: string;
  };
  readonly doc: {
    readonly coverRulePoints: number;
  };
  readonly deck: {
    readonly coverBandPoints: number;
    readonly cardRadius: number;
  };
}

const STANDARD_PALETTE: Palette = {
  brand: "1F4E79",
  brandLight: "4472C4",
  brandDeep: "0563C1",
  brandTint: "EEF3F9",
  surfaceTint: "F4F6F9",
  ink: "212529",
  inkMuted: "595959",
  rule: "D9DEE5",
  onBrand: "FFFFFF",
  positive: "1BAF7A",
  negative: "E34948",
};

const EXECUTIVE_PALETTE: Palette = {
  brand: "17324D",
  brandLight: "2D6A78",
  brandDeep: "0B5D7A",
  brandTint: "EAF1F3",
  surfaceTint: "F5F7F8",
  ink: "18222B",
  inkMuted: "4F5D68",
  rule: "CBD5DB",
  onBrand: "FFFFFF",
  positive: "147D64",
  negative: "B8433F",
};

const CONSULTING_PALETTE: Palette = {
  brand: "0B2D4D",
  brandLight: "007481",
  brandDeep: "005A8D",
  brandTint: "E7F3F4",
  surfaceTint: "F2F6F8",
  ink: "17232D",
  inkMuted: "52616D",
  rule: "C9D5DB",
  onBrand: "FFFFFF",
  positive: "147D64",
  negative: "B8433F",
};

const FORMAL_PALETTE: Palette = {
  brand: "334E68",
  brandLight: "627D98",
  brandDeep: "245B78",
  brandTint: "EDF1F4",
  surfaceTint: "F7F7F5",
  ink: "20252A",
  inkMuted: "525A61",
  rule: "CDD2D6",
  onBrand: "FFFFFF",
  positive: "287A62",
  negative: "A94743",
};

const TECHNICAL_PALETTE: Palette = {
  brand: "0F4C5C",
  brandLight: "147D75",
  brandDeep: "075A72",
  brandTint: "E8F3F1",
  surfaceTint: "F2F7F6",
  ink: "162629",
  inkMuted: "4C6063",
  rule: "C6D6D3",
  onBrand: "FFFFFF",
  positive: "147D64",
  negative: "B8433F",
};

const CATEGORICAL = [
  "2A78D6",
  "EB6834",
  "1BAF7A",
  "EDA100",
  "E87BA4",
  "4A3AA7",
  "E34948",
  "898781",
] as const;

function profile(
  name: DocumentProfile,
  label: string,
  description: string,
  palette: Palette,
  options: {
    header: "solid" | "light";
    coverRulePoints: number;
    coverBandPoints: number;
    cardRadius: number;
  },
): DesignProfile {
  return {
    profile: name,
    label,
    description,
    palette,
    chart: CATEGORICAL,
    table: {
      headerFill: options.header === "solid" ? palette.brand : palette.brandTint,
      headerText: options.header === "solid" ? palette.onBrand : palette.brand,
    },
    doc: { coverRulePoints: options.coverRulePoints },
    deck: { coverBandPoints: options.coverBandPoints, cardRadius: options.cardRadius },
  };
}

export const DESIGNS: Readonly<Record<DocumentProfile, DesignProfile>> = {
  executive: profile(
    "executive",
    "Executive",
    "Leadership decisions, board reports and approval documents.",
    EXECUTIVE_PALETTE,
    { header: "solid", coverRulePoints: 48, coverBandPoints: 12, cardRadius: 1500 },
  ),
  consulting: profile(
    "consulting",
    "Consulting",
    "Strategy proposals and conclusion-led presentations.",
    CONSULTING_PALETTE,
    { header: "solid", coverRulePoints: 72, coverBandPoints: 36, cardRadius: 5000 },
  ),
  formal: profile(
    "formal",
    "Formal",
    "Public-sector and external submissions designed first for print.",
    FORMAL_PALETTE,
    { header: "light", coverRulePoints: 36, coverBandPoints: 0, cardRadius: 0 },
  ),
  technical: profile(
    "technical",
    "Technical",
    "Architecture, RFC and engineering documents with restrained structure.",
    TECHNICAL_PALETTE,
    { header: "light", coverRulePoints: 42, coverBandPoints: 6, cardRadius: 1000 },
  ),
  standard: profile(
    "standard",
    "Standard",
    "The classic neutral corporate document style.",
    STANDARD_PALETTE,
    { header: "solid", coverRulePoints: 60, coverBandPoints: 21.6, cardRadius: 8000 },
  ),
};

export function designFor(profileName: DocumentProfile = DEFAULT_PROFILE): DesignProfile {
  return DESIGNS[profileName];
}

export const PALETTE = designFor().palette;

export type ColourName = keyof Palette;

/**
 * A categorical chart palette, validated for colour-vision
 * deficiency and for contrast on a light surface.
 *
 * Nothing in this repository draws a chart. It is here because a PPTX carries a
 * theme, and that theme is the swatch list a reader sees when they add a shape
 * or a chart to the deck we handed them — leaving Office's defaults there means
 * their first edit is off-brand. Six of the eight fit the theme's six accent
 * slots; `#008300` is dropped for being a second green, and the order is kept
 * otherwise.
 */
export const CHART = designFor().chart;

/** `#RRGGBB`, which is the form HWPX and the OOXML `srgbClr` attribute want. */
export function hashed(name: ColourName, palette: Palette = PALETTE): string {
  return `#${palette[name]}`;
}

/**
 * Channels as floats in 0-1, for `pdf-lib`'s `rgb()`.
 *
 * Returned as a plain object rather than a `RGB`: this module is imported by
 * three renderers that have no business loading `pdf-lib`, and the PDF one
 * wraps it in a single call at the point of use.
 */
export function rgbOf(name: ColourName, palette: Palette = PALETTE): { r: number; g: number; b: number } {
  const hex = palette[name];
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/* ------------------------------------------------------------------ scale */

/**
 * Two scales, because a page and a screen are read from different distances.
 *
 * Both are in **points**, which is the only unit all four formats can be
 * derived from, and the converters below do the deriving.
 *
 * Every page renderer uses `DOC`; the deck uses `DECK` because a projected
 * screen is read from a different distance. Shared role names keep the same
 * information hierarchy while allowing those two media to use honest sizes.
 */
export const DOC = {
  body: 11,
  code: 9.5,
  /** Levels 1 to 6. */
  headings: [20, 17, 15, 13, 12, 11],
  /** Page numbers, sources, anything set below the body. */
  caption: 8.5,
  /** The cover's title and its second line, a page read at arm's length. */
  coverTitle: 30,
  subtitle: 13,
  /** A chapter's "01" — a mark at the top of the page, not text. */
  ordinal: 36,
  /** A key figure in a metrics strip: the biggest thing on a page of prose. */
  metric: 26,
} as const;

export const DECK = {
  coverTitle: 44,
  /** The cover's second line, under the title and quieter than it. */
  subtitle: 20,
  title: 32,
  /** A section divider's title, sitting alone on a brand field. */
  sectionTitle: 40,
  /** The divider's "01" — a numeral this large is a mark, not text. */
  ordinal: 66,
  /** The closing slide's one line, between a title and a cover in weight. */
  closingTitle: 36,
  body: 18,
  code: 14,
  /** Headings 3 to 6, which stay in a slide's body rather than opening one. */
  subheadings: [22, 20, 18, 18],
  caption: 11,
  /** A card's heading, and the line or two under it. */
  cardTitle: 18,
  cardBody: 14,
  /** A metric's number — the biggest thing on its slide bar the title. */
  metric: 44,
  metricLabel: 13,
  /** A pulled quote, set alone: bigger than body, smaller than a title. */
  quote: 24,
} as const;

/**
 * Leading is role-based rather than format-default-based.
 *
 * Korean body copy needs more air than Latin prose, while display text needs
 * tighter lines so a wrapped title reads as one unit. Slides are read at a
 * distance and use a slightly denser body rhythm than printed pages. `compact`
 * is for tables and code, where rows already supply additional separation.
 */
export const LEADING = {
  document: {
    body: 1.5,
    heading: 1.2,
    coverTitle: 1.15,
    subtitle: 1.4,
    compact: 1.35,
  },
  deck: {
    body: 1.35,
    title: 1.15,
    coverTitle: 1.1,
    subtitle: 1.3,
  },
} as const;

/**
 * Preserve each installed font's native glyph widths. Kerning is allowed from
 * 12pt upward, where Latin display text benefits from it; Hangul remains on
 * its natural square advance. No renderer compresses text to make it fit.
 */
export const TYPOGRAPHY = {
  tracking: 0,
  kerningFromPoints: 12,
} as const;

/* -------------------------------------------------------------- converters */

/** DOCX `w:sz`, which counts half-points. */
export function halfPoints(points: number): number {
  return Math.round(points * 2);
}

/** DOCX lengths, and HWPX line spacing: twentieths of a point. */
export function twips(points: number): number {
  return Math.round(points * 20);
}

/**
 * HWPX `height` and DrawingML `sz`, both hundredths of a point.
 *
 * The same number serves as HWPUNIT for a *character* size — HWPUNIT is
 * 1/7200 inch and a point is 1/72, so one point is one hundred of them. It is
 * not the converter for a *length*; `hwpunit` below is, and they agree by
 * arithmetic rather than by coincidence.
 */
export function centiPoints(points: number): number {
  return Math.round(points * 100);
}

/** HWPX lengths: 1/7200 inch. */
export function hwpunit(points: number): number {
  return Math.round(points * 100);
}

/** DrawingML lengths: 914,400 to the inch. */
export function emu(points: number): number {
  return Math.round(points * 12700);
}
