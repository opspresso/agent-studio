/**
 * The XML scaffolding every part of a PPTX shares.
 *
 * Namespaces, the declaration line, the relationship builders and the two fixed
 * GUIDs — the strings that would otherwise be restated in every module of this
 * package, where they could drift the way the renderers' colours once did.
 */

import { escapeXml } from "../../xml";

export const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

export const SLIDE_LAYOUT_TYPE = `${R}/slideLayout`;
export const SLIDE_MASTER_TYPE = `${R}/slideMaster`;
export const SLIDE_TYPE = `${R}/slide`;
export const THEME_TYPE = `${R}/theme`;
export const HYPERLINK_TYPE = `${R}/hyperlink`;
export const IMAGE_TYPE = `${R}/image`;

/**
 * PowerPoint's own default table style, referenced by GUID.
 *
 * The GUID names a style built into PowerPoint itself; the `tableStyles.xml`
 * part this package carries declares it as the default and defines nothing.
 * That is exactly what PowerPoint writes for a fresh file — a table whose
 * `tblPr` names no style is a table no native file contains, and Windows
 * PowerPoint treats several such never-written shapes as damage.
 */
export const TABLE_STYLE_ID = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

/**
 * The slide-number field's id — fixed rather than generated, for the reason the
 * created date is passed in: the bytes have to follow from the input alone, and
 * nothing distinguishes one deck's number field from another's.
 */
export const NUMBER_FIELD_ID = "{7B4A2F5C-0E31-4C6D-9A2B-51D0C8E3F614}";

const encoder = new TextEncoder();

export function part(xml: string): Uint8Array {
  return encoder.encode(DECLARATION + xml);
}

export function relationships(entries: readonly string[]): string {
  return `<Relationships xmlns="${RELATIONSHIPS}">${entries.join("")}</Relationships>`;
}

export function relationship(id: string, type: string, target: string, external = false): string {
  return (
    `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"` +
    `${external ? ' TargetMode="External"' : ""}/>`
  );
}
