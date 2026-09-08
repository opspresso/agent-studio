import {
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
  DOCUMENT_PROFILES,
  type CreateDocumentInput,
  type CreatedDocument,
  type DocumentRenderer,
} from "@/domain/document/processor";
import { DocumentError } from "./engine/errors";
import { MAX_ASSET_COUNT, MAX_ASSET_TOTAL_BYTES, MAX_MARKDOWN_CHARS, MAX_RENDERED_BYTES } from "./engine/limits";
import { parseMarkdown } from "./engine/markdown";
import { validateRenderedDocument } from "./engine/validate";
import { imageSize } from "./engine/write/image";

function validateInput(input: CreateDocumentInput): void {
  if (!DOCUMENT_FORMATS.includes(input.format)) {
    throw new DocumentError("Unsupported document output format");
  }
  if (input.profile !== undefined && !DOCUMENT_PROFILES.includes(input.profile)) {
    throw new DocumentError("Unsupported document profile");
  }
  if (!input.title.trim() || input.title.length > 500) {
    throw new DocumentError("Document title must contain 1–500 characters");
  }
  if (!Number.isFinite(Date.parse(input.created))) {
    throw new DocumentError("Document creation time must be an ISO date");
  }
  if (input.format === "xlsx") {
    if (input.content !== undefined || input.profile !== undefined) {
      throw new DocumentError("XLSX takes sheets, not Markdown or a document profile");
    }
  } else if (typeof input.content !== "string" || !input.content.trim() || input.content.length > MAX_MARKDOWN_CHARS) {
    throw new DocumentError(`Document Markdown must contain 1–${MAX_MARKDOWN_CHARS} characters`);
  } else if (input.sheets !== undefined) {
    throw new DocumentError("Only XLSX takes sheets");
  }
  const assets = Object.entries(input.assets ?? {});
  if (assets.length === 0) return;
  if (input.format === "hwpx" || input.format === "xlsx") {
    throw new DocumentError("Image assets are supported in DOCX, PPTX and PDF only");
  }
  if (assets.length > MAX_ASSET_COUNT) {
    throw new DocumentError(`A document accepts at most ${MAX_ASSET_COUNT} image assets`);
  }
  let total = 0;
  for (const [name, asset] of assets) {
    if (!/^[\p{L}\p{N}_.-]+$/u.test(name)) {
      throw new DocumentError("Asset names may contain letters, numbers, dots, dashes and underscores");
    }
    if (asset.mimeType !== "image/png" && asset.mimeType !== "image/jpeg") {
      throw new DocumentError("Document assets must be PNG or JPEG images");
    }
    total += asset.bytes.byteLength;
    if (total > MAX_ASSET_TOTAL_BYTES) {
      throw new DocumentError(`Document image assets exceed ${MAX_ASSET_TOTAL_BYTES} bytes`);
    }
    imageSize(asset.bytes, asset.mimeType);
  }
}

/** Creates and reopens a document before returning it; never stores or publishes bytes. */
export async function createDocument(input: CreateDocumentInput): Promise<CreatedDocument> {
  validateInput(input);
  let bytes: Uint8Array;
  let counts: Record<string, number> = {};
  const warnings: string[] = [];
  if (input.format === "xlsx") {
    const { renderXlsx } = await import("./engine/write/xlsx");
    const rendered = renderXlsx(input.sheets, input);
    bytes = rendered.bytes;
    counts = { sheets: rendered.sheets, rows: rendered.rows, cells: rendered.cells, formulas: rendered.formulas };
    if (rendered.formulas > 0) {
      warnings.push("Formula results were not calculated or verified; recalculation is requested on open.");
    }
  } else {
    const document = parseMarkdown(input.content!);
    if (input.format === "docx") {
      const { renderDocx } = await import("./engine/write/docx");
      bytes = renderDocx(document, input);
    } else if (input.format === "hwpx") {
      const { renderHwpx } = await import("./engine/write/hwpx");
      bytes = renderHwpx(document, input);
    } else if (input.format === "pptx") {
      const { renderPptx } = await import("./engine/write/pptx");
      const rendered = renderPptx(document, input);
      bytes = rendered.bytes;
      counts = { slides: rendered.slides, continuations: rendered.continuations };
      if (rendered.continuations > 0) {
        warnings.push(`${rendered.continuations} continuation slide(s) were created; review deck density.`);
      }
    } else {
      const { renderPdf } = await import("./engine/write/pdf");
      const rendered = await renderPdf(document, { ...input, created: new Date(input.created) });
      bytes = rendered.bytes;
      counts = { pages: rendered.pages };
    }
  }
  if (bytes.byteLength > MAX_RENDERED_BYTES) {
    throw new DocumentError(`The rendered document exceeds ${MAX_RENDERED_BYTES} bytes; split it into smaller files`);
  }
  const validation = await validateRenderedDocument(input.format, bytes, counts.pages);
  return {
    bytes,
    mimeType: DOCUMENT_MIME_TYPES[input.format],
    counts,
    validation: { ...validation, warnings: [...validation.warnings, ...warnings] },
  };
}

export const documentRenderer: DocumentRenderer = {
  async create(input, signal) {
    signal?.throwIfAborted();
    const result = await createDocument(input);
    signal?.throwIfAborted();
    return result;
  },
};
