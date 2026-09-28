export const MAX_DOCUMENT_EDITS = 100;
export const MAX_DOCUMENT_ASSETS = 12;
export const MAX_DOCUMENT_ASSET_BYTES = 6 * 1024 * 1024;
export const MAX_DOCUMENT_TOOL_CHARS = 90_000;

/** Document operations consume bytes; file identity and storage belong to the caller. */
export const DOCUMENT_FORMATS = ["docx", "pdf", "hwpx", "pptx", "xlsx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_PROFILES = ["executive", "consulting", "formal", "technical", "standard"] as const;
export type DocumentProfile = (typeof DOCUMENT_PROFILES)[number];

export const DEFAULT_DOCUMENT_PROFILE: DocumentProfile = "standard";
export const DOCUMENT_THEMES = ["corporate", "classic", "ocean", "slate", "teal"] as const;
export type DocumentTheme = (typeof DOCUMENT_THEMES)[number];
export const DEFAULT_DOCUMENT_THEME: DocumentTheme = "corporate";
export const DOCUMENT_FONT_FAMILY = "NanumGothic";
export const DOCUMENT_LAYOUTS = ["compact", "report"] as const;
export type DocumentLayout = (typeof DOCUMENT_LAYOUTS)[number];

export function documentLayoutFor(format: DocumentFormat, requested?: DocumentLayout): DocumentLayout | null {
  if (format === "xlsx") return null;
  return requested ?? (format === "pptx" ? "report" : "compact");
}

export const DOCUMENT_COLOR_NAMES = [
  "brand", "brandLight", "brandDeep", "brandTint", "surfaceTint", "ink",
  "inkMuted", "rule", "onBrand", "positive", "negative",
] as const;
export type DocumentColorName = (typeof DOCUMENT_COLOR_NAMES)[number];
export type DocumentColors = Readonly<Record<DocumentColorName, string>>;

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

export interface DocumentStyleOptions {
  profile?: DocumentProfile;
  /** Brand palette is independent of document purpose. Colors are six-digit hex without #. */
  theme?: DocumentTheme;
  colors?: Partial<DocumentColors>;
  /** Page documents default to compact; decks default to report. Not applicable to XLSX. */
  layout?: DocumentLayout;
}

export interface CreateDocumentInput extends DocumentStyleOptions {
  format: DocumentFormat;
  title: string;
  created: string;
  /** Markdown for document formats. XLSX takes explicit sheet rows instead. */
  content?: string;
  sheets?: unknown;
  assets?: Record<string, DocumentAsset>;
}

export interface EffectiveDocumentStyle {
  theme: DocumentTheme;
  profile: DocumentProfile | null;
  layout: DocumentLayout | null;
  colors: DocumentColors;
  fontFamily: string;
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
  style?: EffectiveDocumentStyle;
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
