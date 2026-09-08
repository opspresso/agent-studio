import type { SetDocumentCell } from "@/domain/document/processor";
import { DocumentError } from "../errors";
import { columnOf, sheetParts, validateCellAddress } from "../read/xlsx";
import { cellXml, spreadsheetCell } from "../write/xlsx";
import { attributeOf, attributesOf, escapeXml, localName } from "../xml";
import { replaceXml, xmlElements, type XmlElement } from "./xmlElements";
import { decodeUtf8Text } from "@/shared/utf8Text";

const utf8 = (text: string) => new TextEncoder().encode(text);
function xmlOf(parts: Map<string, Uint8Array>, name: string): string {
  const bytes = parts.get(name);
  const text = bytes && decodeUtf8Text(bytes);
  if (text === undefined || text === null) throw new DocumentError(`Missing or non-UTF-8 workbook part: ${name}`);
  return text;
}

function elements(xml: string, name: string): XmlElement[] {
  return xmlElements(xml, (tag) => localName(tag) === name);
}

function qualified(name: string, tag: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? tag : `${name.slice(0, colon)}:${tag}`;
}

function elementXml(element: XmlElement, content: string, attributes = attributesOf(element.attributes)): string {
  const attrs = [...attributes].map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join("");
  return `<${element.name}${attrs}>${content}</${element.name}>`;
}

function cellContent(value: unknown, address: string, name: string) {
  const parsed = spreadsheetCell(value, address);
  const strings = typeof parsed === "object" && parsed !== null
    ? [parsed.formula, ...(typeof parsed.cachedValue === "string" ? [parsed.cachedValue] : [])]
    : typeof parsed === "string" ? [parsed] : [];
  if (strings.some((text) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text) || !text.isWellFormed())) {
    throw new DocumentError("Cell text contains invalid XML characters");
  }
  const rendered = cellXml(parsed, address, false)
    .replace(/(<\/?)(c|f|v|is|t)(?=[\s/>])/g, (_match, open: string, tag: string) => open + qualified(name, tag));
  const cell = elements(rendered, "c")[0]!;
  return { rendered, cell };
}

function replaceCell(xml: string, operation: SetDocumentCell): string {
  const address = operation.cell.toUpperCase();
  validateCellAddress(address);
  const rowIndex = Number(address.replace(/^[A-Z]+/, ""));
  const column = columnOf(address);
  const formulas = elements(xml, "f").filter((node) => node.depth === 4);
  if (formulas.some(({ attributes }) => {
    const type = attributeOf(attributes, "t");
    return type !== undefined && type !== "normal";
  })) {
    throw new DocumentError("Editing worksheets with shared, array or data-table formulas is not supported");
  }
  for (const merge of elements(xml, "mergeCell")) {
    const range = attributeOf(merge.attributes, "ref")?.split(":");
    if (!range?.[0] || !range[1]) continue;
    const firstRow = Number(range[0].replace(/^[A-Za-z]+/, ""));
    const lastRow = Number(range[1].replace(/^[A-Za-z]+/, ""));
    if (column >= columnOf(range[0]) && column <= columnOf(range[1]) && rowIndex >= firstRow && rowIndex <= lastRow && address !== range[0].toUpperCase()) {
      throw new DocumentError("Edit the top-left cell of a merged range");
    }
  }
  const cells = elements(xml, "c").filter((node) => node.depth === 3);
  const matching = cells.filter(({ attributes }) => attributeOf(attributes, "r")?.toUpperCase() === address);
  if (matching.length > 1) throw new DocumentError("The worksheet contains duplicate cell addresses");
  const target = matching[0];
  if (target) {
    const replacement = cellContent(operation.value, address, target.name);
    const attributes = attributesOf(target.attributes);
    const type = attributeOf(replacement.cell.attributes, "t");
    if (type === undefined) attributes.delete("t");
    else attributes.set("t", type);
    const originalBody = xml.slice(target.contentStart, target.contentEnd);
    const values = xmlElements(originalBody, (tag) => ["f", "v", "is"].includes(localName(tag))).filter((node) => node.depth === 0);
    const retainedBody = replaceXml(originalBody, values.map((node) => ({ ...node, replacement: "" })));
    const body = replacement.rendered.slice(replacement.cell.contentStart, replacement.cell.contentEnd) + retainedBody;
    return replaceXml(xml, [{ ...target, replacement: elementXml(target, body, attributes) }]);
  }
  const data = elements(xml, "sheetData")[0];
  if (!data) throw new DocumentError("The worksheet has no sheetData element");
  const rows = elements(xml, "row").filter((row) => row.start >= data.contentStart && row.end <= data.contentEnd);
  const row = rows.find(({ attributes }) => attributeOf(attributes, "r") === String(rowIndex));
  const newCell = cellContent(operation.value, address, data.name).rendered;
  if (row) {
    const rowCells = cells.filter((cell) => cell.start >= row.contentStart && cell.end <= row.contentEnd);
    if (rowCells.some(({ attributes }) => attributeOf(attributes, "r") === undefined)) {
      throw new DocumentError("Cannot insert into a row whose cells omit their addresses");
    }
    const next = rowCells.find(({ attributes }) => columnOf(attributeOf(attributes, "r")!) > column);
    const at = next?.start ?? row.contentEnd;
    const body = xml.slice(row.contentStart, at) + newCell + xml.slice(at, row.contentEnd);
    const attrs = attributesOf(row.attributes);
    attrs.delete("spans");
    return replaceXml(xml, [{ ...row, replacement: elementXml(row, body, attrs) }]);
  }
  if (rows.some(({ attributes }) => attributeOf(attributes, "r") === undefined)) {
    throw new DocumentError("Cannot insert into a sheet whose rows omit their addresses");
  }
  const next = rows.find(({ attributes }) => Number(attributeOf(attributes, "r")) > rowIndex);
  const at = next?.start ?? data.contentEnd;
  const tag = qualified(data.name, "row");
  const newRow = `<${tag} r="${rowIndex}">${newCell}</${tag}>`;
  const body = xml.slice(data.contentStart, at) + newRow + xml.slice(at, data.contentEnd);
  return replaceXml(xml, [{ ...data, replacement: elementXml(data, body) }]);
}

/** Changing a precedent invalidates cached formula results throughout the workbook. */
function clearFormulaCaches(xml: string): string {
  const cells = elements(xml, "c").filter((node) => node.depth === 3);
  const replacements = [];
  for (const cell of cells) {
    const body = xml.slice(cell.contentStart, cell.contentEnd);
    if (!elements(body, "f").some((node) => node.depth === 0)) continue;
    const values = elements(body, "v").filter((node) => node.depth === 0);
    if (values.length === 0) continue;
    const content = replaceXml(body, values.map((value) => ({ ...value, replacement: "" })));
    replacements.push({ ...cell, replacement: elementXml(cell, content) });
  }
  return replaceXml(xml, replacements);
}

function requestRecalculation(xml: string): string {
  const existing = elements(xml, "calcPr").find((node) => node.depth === 1);
  if (existing) {
    const attrs = attributesOf(existing.attributes);
    attrs.set("calcMode", "auto");
    attrs.set("fullCalcOnLoad", "1");
    attrs.set("forceFullCalc", "1");
    return replaceXml(xml, [{ ...existing, replacement: elementXml(existing, "", attrs) }]);
  }
  const root = elements(xml, "workbook")[0];
  if (!root) throw new DocumentError("The workbook root is missing");
  const afterCalculation = new Set(["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"]);
  const next = xmlElements(xml, (name) => afterCalculation.has(localName(name))).find((node) => node.depth === 1);
  const at = next?.start ?? root.contentEnd;
  const tag = qualified(root.name, "calcPr");
  return xml.slice(0, at) + `<${tag} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>` + xml.slice(at);
}

/** Returns a new part map. Styles, drawings, comments and unrelated parts remain unchanged. */
export function editWorkbook(original: Map<string, Uint8Array>, operations: readonly SetDocumentCell[]): Map<string, Uint8Array> {
  if ([...original.keys()].some((name) => /(?:vbaProject\.bin|_xmlsignatures\/)/i.test(name))) {
    throw new DocumentError("Editing macro-enabled or signed workbooks is not supported");
  }
  if (/macroEnabled|vbaProject/i.test(xmlOf(original, "[Content_Types].xml"))) {
    throw new DocumentError("Editing macro-enabled workbooks is not supported");
  }
  const parts = new Map(original);
  const workbook = xmlOf(parts, "xl/workbook.xml");
  const sheets = sheetParts(workbook, xmlOf(parts, "xl/_rels/workbook.xml.rels"), true);
  const seen = new Set<string>();
  for (const operation of operations) {
    if (operation.operation !== "set_cell" || typeof operation.sheet !== "string" || typeof operation.cell !== "string") {
      throw new DocumentError("XLSX edits require a sheet name, cell address and value");
    }
    const key = JSON.stringify([operation.sheet, operation.cell.toUpperCase()]);
    if (seen.has(key)) throw new DocumentError("Edit each workbook cell only once");
    seen.add(key);
    const sheet = sheets.find(({ name }) => name === operation.sheet);
    if (!sheet) throw new DocumentError(`Worksheet not found: ${operation.sheet}`);
    let xml = replaceCell(xmlOf(parts, sheet.path), operation);
    // Optional cached extent; removing it lets the reader derive the new occupied range.
    xml = replaceXml(xml, elements(xml, "dimension").map((node) => ({ ...node, replacement: "" })));
    parts.set(sheet.path, utf8(xml));
  }
  for (const sheet of sheets) {
    parts.set(sheet.path, utf8(clearFormulaCaches(xmlOf(parts, sheet.path))));
  }
  parts.set("xl/workbook.xml", utf8(requestRecalculation(workbook)));
  // The old dependency chain no longer describes the edited formulas.
  const relsName = "xl/_rels/workbook.xml.rels";
  const rels = xmlOf(parts, relsName);
  const chainRels = elements(rels, "Relationship").filter(({ attributes }) => attributeOf(attributes, "Type")?.endsWith("/calcChain"));
  parts.set(relsName, utf8(replaceXml(rels, chainRels.map((node) => ({ ...node, replacement: "" })))));
  const types = xmlOf(parts, "[Content_Types].xml");
  const chains = elements(types, "Override").filter(({ attributes }) => attributeOf(attributes, "ContentType")?.includes("calcChain"));
  for (const entry of chains) {
    const name = attributeOf(entry.attributes, "PartName")?.replace(/^\//, "");
    if (name) parts.delete(name);
  }
  parts.set("[Content_Types].xml", utf8(replaceXml(types, chains.map((node) => ({ ...node, replacement: "" })))));
  return parts;
}
