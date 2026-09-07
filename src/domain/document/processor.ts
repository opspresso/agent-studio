/** Document operations consume bytes; file identity and storage belong to the caller. */
export const DOCUMENT_FORMATS = ["docx", "pdf", "hwpx", "pptx", "xlsx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_PROFILES = ["executive", "consulting", "formal", "technical", "standard"] as const;
export type DocumentProfile = (typeof DOCUMENT_PROFILES)[number];

export const DOCUMENT_MIME_TYPES: Record<DocumentFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  hwpx: "application/hwp+zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export class DocumentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentProcessingError";
  }
}

export interface DocumentAsset {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
}

export interface CreateDocumentInput {
  format: DocumentFormat;
  title: string;
  created: string;
  /** Markdown for document formats. XLSX takes explicit sheet rows instead. */
  content?: string;
  sheets?: unknown;
  profile?: DocumentProfile;
  assets?: Record<string, DocumentAsset>;
}

export interface DocumentValidation {
  structure: "passed";
  content: "reopened" | "not_checked";
  visual: "not_run";
  externalRelationships: number;
  warnings: string[];
}

export interface CreatedDocument {
  bytes: Uint8Array;
  mimeType: string;
  validation: DocumentValidation;
  counts: Record<string, number>;
}

export interface DocumentRenderer {
  create(input: CreateDocumentInput, signal?: AbortSignal): Promise<CreatedDocument>;
}

export interface DocumentFile {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

export interface DocumentTextTarget {
  part: string;
  index: number;
  text: string;
}

export interface ReplaceDocumentText extends DocumentTextTarget {
  operation: "replace_text";
  replacement: string;
}

export type SpreadsheetScalar = string | number | boolean | null;
export type SpreadsheetCell = SpreadsheetScalar | { formula: string; cachedValue?: SpreadsheetScalar };

export interface SetDocumentCell {
  operation: "set_cell";
  sheet: string;
  cell: string;
  value: SpreadsheetCell;
}

export type DocumentEdit = ReplaceDocumentText | SetDocumentCell;
export interface DocumentInspectionOptions {
  from?: number;
  includeHidden?: boolean;
  mode?: "structure" | "edit_targets";
}

export interface DocumentInspection {
  format: string;
  text: string;
  complete: boolean;
  targets: DocumentTextTarget[];
  warnings: string[];
}

export interface DocumentEditor {
  inspect(file: DocumentFile, options?: DocumentInspectionOptions, signal?: AbortSignal): Promise<DocumentInspection>;
  edit(file: DocumentFile, operations: readonly DocumentEdit[], signal?: AbortSignal): Promise<CreatedDocument>;
}
