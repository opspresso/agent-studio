import {
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_EDITS,
  type CreatedDocument,
  type DocumentEditor,
  type DocumentFile,
  type DocumentInspection,
  type DocumentEdit,
  type DocumentInspectionOptions,
  type ReplaceDocumentText,
  type SetDocumentCell,
} from "@/domain/document/processor";
import { MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";
import { cutCodePoints, decodeUtf8Text } from "@/shared/utf8Text";
import { detect } from "./engine/detect";
import { DocumentError } from "./engine/errors";
import { MAX_INSPECTED_BLOCKS, MAX_MARKDOWN_CHARS, MAX_RENDERED_BYTES, MAX_TEXT_CHARS } from "./engine/limits";
import { inspectXlsx } from "./engine/read/xlsx";
import { editWorkbook } from "./engine/edit/xlsx";
import { inspectBlocks } from "./engine/read/inspect";
import { readBlocks, readDocument } from "./engine/read/document";
import { attributeOf, attributesOf, escapeXml, localName } from "./engine/xml";
import { buildZip, openZip, stored } from "./engine/zip";
import { replaceXml, xmlElements, type XmlReplacement } from "./engine/edit/xmlElements";

const TEXT_PARTS = {
  docx: /^word\/(?:document|header\d+|footer\d+)\.xml$/,
  pptx: /^ppt\/slides\/slide\d+\.xml$/,
  hwpx: /^Contents\/section\d+\.xml$/,
};
const TEXT_TAGS = { docx: "w:t", pptx: "a:t", hwpx: "hp:t" };
type EditableFormat = keyof typeof TEXT_PARTS;

function packageOf(file: DocumentFile) {
  if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentError("The source document is too large to edit");
  const detected = detect(file.bytes, file.mimeType, file.name);
  if (detected.format !== "docx" && detected.format !== "pptx" && detected.format !== "hwpx" && detected.format !== "xlsx") {
    throw new DocumentError("Editing supports DOCX, PPTX, HWPX and XLSX only");
  }
  const zip = openZip(file.bytes);
  const names = zip.entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new DocumentError("Cannot edit an archive with duplicate entries");
  if (names.some((name) => name.startsWith("_xmlsignatures/") || /^META-INF\/signatures?\.xml$/i.test(name))) {
    throw new DocumentError("Cannot edit a signed document without invalidating its signature");
  }
  return { format: detected.format, parts: zip.read(names) };
}

function xmlOf(bytes: Uint8Array): string {
  const text = decodeUtf8Text(bytes);
  if (text === null) throw new DocumentError("Editable XML parts must be UTF-8");
  return text;
}

function textElements(xml: string, format: EditableFormat) {
  return xmlElements(xml, (name) => name === TEXT_TAGS[format]);
}

export async function inspectDocument(file: DocumentFile, options: DocumentInspectionOptions = {}): Promise<DocumentInspection> {
  const from = options.from ?? 0;
  if (!Number.isInteger(from) || from < 0) throw new DocumentError("Inspection offset must be a non-negative integer");
  if (file.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentError("The source document is too large to inspect");
  const detected = detect(file.bytes, file.mimeType, file.name);
  if (detected.format !== "xlsx" && (options.mode === "structure" || ["hwp", "odf", "rtf"].includes(detected.format))) {
    const read = await readBlocks({ bytes: file.bytes, mimeType: file.mimeType, filename: file.name, label: file.name });
    const inspection = from >= read.blocks.length ? { text: "", complete: true } : inspectBlocks(read.blocks, { from });
    return { format: read.format, text: inspection.text, complete: inspection.complete, targets: [], warnings: read.omissions };
  }
  const { format, parts } = packageOf(file);
  if (format === "xlsx") {
    const inspected = inspectXlsx(file.bytes, options.includeHidden);
    const cells = inspected.sheets.flatMap((sheet) => sheet.cells.map((cell) => ({ sheet: sheet.name, state: sheet.state, ...cell })));
    const window = cells.slice(from, from + MAX_INSPECTED_BLOCKS);
    const text = window.map((cell) => JSON.stringify(cell)).join("\n");
    const bounded = cutCodePoints(text, MAX_TEXT_CHARS);
    return {
      format, text: bounded, targets: [],
      complete: inspected.complete && from + window.length >= cells.length && bounded.length === text.length,
      warnings: [
        "Formulas are shown with their cached values and are not recalculated.",
        ...(inspected.hiddenSheets && !options.includeHidden ? ["Hidden worksheets were omitted; use includeHidden to inspect them."] : []),
        ...(inspected.macroEnabled ? ["The workbook contains macros; they were not executed."] : []),
        ...(inspected.externalLinks ? ["External workbook links were not followed."] : []),
        ...(!inspected.complete ? ["The workbook exceeds the bounded cell inspection budget."] : []),
        ...(bounded.length !== text.length ? ["The cell text was truncated at the inspection character budget."] : []),
      ],
    };
  }
  const targets: DocumentInspection["targets"] = [];
  const lines: string[] = [];
  const warnings: string[] = [];
  let ordinal = 0;
  let used = 0;
  let complete = true;
  for (const [part, bytes] of parts) {
    if (!TEXT_PARTS[format].test(part)) continue;
    const elements = textElements(xmlOf(bytes), format);
    for (const [index, element] of elements.entries()) {
      if (ordinal++ < from) continue;
      const target = { part, index, text: element.text };
      const line = JSON.stringify({ ...target, editable: !element.nested });
      if (lines.length >= MAX_INSPECTED_BLOCKS || used + line.length + 1 > MAX_TEXT_CHARS) {
        complete = false;
        if (lines.length === 0) {
          lines.push(JSON.stringify({ part, index, editable: false, reason: "Text target exceeds the inspection budget" }));
          warnings.push(`Target at offset ${ordinal - 1} is too large for text target editing; continue at ${ordinal}.`);
        } else {
          warnings.push(`Inspection stopped at offset ${ordinal - 1}; request that offset to continue.`);
        }
        return { format, text: lines.join("\n"), targets, complete, warnings };
      }
      lines.push(line);
      used += line.length + 1;
      if (!element.nested) targets.push(target);
    }
  }
  return { format, text: lines.join("\n"), targets, complete, warnings };
}

/** Patch explicit text targets while preserving all other uncompressed package entries. */
export async function editDocument(file: DocumentFile, operations: readonly DocumentEdit[]): Promise<CreatedDocument> {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_DOCUMENT_EDITS) {
    throw new DocumentError(`Supply 1–${MAX_DOCUMENT_EDITS} document edits`);
  }
  const opened = packageOf(file);
  const format = opened.format;
  let parts = opened.parts;
  if (format === "xlsx") {
    if (operations.some((operation) => operation.operation !== "set_cell")) throw new DocumentError("XLSX requires set_cell edits");
    if (JSON.stringify(operations).length > MAX_MARKDOWN_CHARS) throw new DocumentError("The cell edits exceed the document text budget");
    parts = editWorkbook(parts, operations as readonly SetDocumentCell[]);
  } else {
    if (operations.some((operation) => operation.operation !== "replace_text")) throw new DocumentError("This format requires replace_text edits");
    const textOperations = operations as readonly ReplaceDocumentText[];
    const changes = new Map<string, XmlReplacement[]>();
    const originals = new Map<string, string>();
    const nodes = new Map<string, ReturnType<typeof textElements>>();
    let total = 0;
    for (const operation of textOperations) {
      if (operation.operation !== "replace_text" || typeof operation.part !== "string" ||
          typeof operation.text !== "string" || typeof operation.replacement !== "string" ||
          !Number.isInteger(operation.index) || operation.index < 0) {
        throw new DocumentError("A text edit requires part, index, original text and replacement");
      }
      total += operation.text.length + operation.replacement.length;
      if (total > MAX_MARKDOWN_CHARS) throw new DocumentError("The text edits exceed the document text budget");
      if (/[\u0000-\u001f\ufffe\uffff]/.test(operation.replacement) || !operation.replacement.isWellFormed()) {
        throw new DocumentError("Text target edits require single-line text without control characters");
      }
      const bytes = parts.get(operation.part);
      if (!bytes || !TEXT_PARTS[format].test(operation.part)) throw new DocumentError("The requested part is not an editable document text part");
      const xml = originals.get(operation.part) ?? xmlOf(bytes);
      originals.set(operation.part, xml);
      const elements = nodes.get(operation.part) ?? textElements(xml, format);
      nodes.set(operation.part, elements);
      const target = elements[operation.index];
      if (!target || target.nested || target.text !== operation.text) {
        throw new DocumentError("The text target does not match; inspect the original file before editing");
      }
      const attributes = attributesOf(target.attributes);
      attributes.set("xml:space", "preserve");
      const serialized = [...attributes].map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join("");
      const replacement = `<${target.name}${serialized}>${escapeXml(operation.replacement)}</${target.name}>`;
      const edits = changes.get(operation.part) ?? [];
      edits.push({ start: target.start, end: target.end, replacement });
      changes.set(operation.part, edits);
    }
    for (const [part, edits] of changes) {
      const edited = replaceXml(originals.get(part)!, edits);
      textElements(edited, format);
      parts.set(part, new TextEncoder().encode(edited));
    }
  }
  const output = buildZip(Object.fromEntries([...parts].map(([name, bytes]) => [name, name === "mimetype" ? stored(bytes) : bytes])));
  if (output.byteLength > MAX_RENDERED_BYTES) throw new DocumentError("The edited document exceeds the output byte limit");
  const reopened = openZip(output);
  if (reopened.entries.length !== parts.size) throw new DocumentError("The edited package lost entries");
  await readDocument({ bytes: output, mimeType: DOCUMENT_MIME_TYPES[format], filename: file.name, label: file.name });
  let externalRelationships = 0;
  for (const [name, bytes] of parts) {
    if (!name.endsWith(".rels")) continue;
    externalRelationships += xmlElements(xmlOf(bytes), (tag) => localName(tag) === "Relationship")
      .filter((element) => attributeOf(element.attributes, "TargetMode") === "External").length;
  }
  return {
    bytes: output, mimeType: DOCUMENT_MIME_TYPES[format], counts: { edits: operations.length },
    validation: {
      structure: "passed", content: "reopened", visual: "not_run", externalRelationships,
      warnings: format === "xlsx"
        ? ["Formula caches were cleared and recalculation is requested on open. Formulas were not calculated. Styles and unrelated package entries were retained."]
        : ["Only the selected text elements changed. Text length changes may affect layout; visual validation was not run."],
    },
  };
}

export const documentEditor: DocumentEditor = {
  async inspect(file, options, signal) {
    signal?.throwIfAborted();
    const result = await inspectDocument(file, options);
    signal?.throwIfAborted();
    return result;
  },
  async edit(file, operations, signal) {
    signal?.throwIfAborted();
    const result = await editDocument(file, operations);
    signal?.throwIfAborted();
    return result;
  },
};
