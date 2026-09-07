import { posix } from "node:path";
import { PDFDocument } from "pdf-lib";
import { DocumentError } from "./errors";
import { docxToText } from "./read/docx";
import { hwpxToText } from "./read/hwpx";
import { pptxToText } from "./read/pptx";
import { inspectXlsx } from "./read/xlsx";
import { attributeOf } from "./xml";
import { openZip } from "./zip";

export class ValidationError extends DocumentError {}

export type RenderFormat = "docx" | "pdf" | "hwpx" | "pptx" | "xlsx";

export interface ValidationReport {
  structure: "passed";
  content: "reopened" | "not_checked";
  visual: "not_run";
  externalRelationships: number;
  warnings: string[];
}

const REQUIRED: Record<Exclude<RenderFormat, "pdf">, readonly string[]> = {
  docx: [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "docProps/app.xml",
    "word/document.xml",
    "word/styles.xml",
  ],
  pptx: [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "docProps/app.xml",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
  ],
  hwpx: [
    "mimetype",
    "META-INF/manifest.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
  ],
  xlsx: [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "docProps/app.xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ],
};

function relationshipBase(name: string): string | undefined {
  if (name === "_rels/.rels") {
    return "";
  }
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(name);
  return match ? match[1] : undefined;
}

function relationshipTargets(
  entries: ReadonlySet<string>,
  parts: ReadonlyMap<string, Uint8Array>,
): number {
  let external = 0;
  const decoder = new TextDecoder();
  for (const [name, bytes] of parts) {
    const base = relationshipBase(name);
    if (base === undefined) {
      continue;
    }
    const xml = decoder.decode(bytes);
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
      const attributes = match[1] ?? "";
      const target = attributeOf(attributes, "Target");
      if (!target) {
        throw new ValidationError(`${name} has a relationship without a target`);
      }
      if (attributeOf(attributes, "TargetMode") === "External") {
        external += 1;
        continue;
      }
      const resolved = target.startsWith("/")
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(base, target));
      if (resolved === ".." || resolved.startsWith("../") || !entries.has(resolved)) {
        throw new ValidationError(`${name} points to missing package part ${JSON.stringify(resolved)}`);
      }
    }
  }
  return external;
}

function packageReport(format: Exclude<RenderFormat, "pdf">, bytes: Uint8Array): ValidationReport {
  const { entries, read } = openZip(bytes);
  const names = new Set(entries.map((entry) => entry.name));
  const missing = REQUIRED[format].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new ValidationError(`the rendered ${format} is missing ${missing.join(", ")}`);
  }

  const relationshipNames = entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".rels"));
  const externalRelationships = relationshipTargets(names, read(relationshipNames));

  if (format === "docx") {
    docxToText(bytes);
  } else if (format === "pptx") {
    pptxToText(bytes);
  } else if (format === "hwpx") {
    hwpxToText(bytes);
  } else {
    inspectXlsx(bytes);
  }

  return {
    structure: "passed",
    content: "reopened",
    visual: "not_run",
    externalRelationships,
    warnings: ["Visual layout was not rendered; inspect the artifact when appearance is critical."],
  };
}

export async function validateRenderedDocument(
  format: RenderFormat,
  bytes: Uint8Array,
  expectedPages?: number,
): Promise<ValidationReport> {
  if (format !== "pdf") {
    return packageReport(format, bytes);
  }
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "%PDF") {
    throw new ValidationError("the rendered PDF has no PDF header");
  }
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPageCount();
  if (pages < 1 || (expectedPages !== undefined && pages !== expectedPages)) {
    throw new ValidationError(
      `the rendered PDF reopened with ${pages} pages; expected ${expectedPages ?? "at least one"}`,
    );
  }
  return {
    structure: "passed",
    content: "not_checked",
    visual: "not_run",
    externalRelationships: 0,
    warnings: [
      "PDF pages reopened successfully, but text preservation and visual layout were not rechecked.",
    ],
  };
}
