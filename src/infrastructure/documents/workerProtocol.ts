import type { CreateDocumentInput, CreatedDocument, DocumentEdit, DocumentFile, DocumentInspection, DocumentInspectionOptions } from "@/domain/document/processor";
import type { DocumentExtractor, ExtractedDocument } from "@/domain/llm/documentExtractor";

export interface DocumentRequests {
  extract: Omit<Parameters<DocumentExtractor["extract"]>[0], "signal">;
  create: CreateDocumentInput;
  inspect: { file: DocumentFile; options?: DocumentInspectionOptions };
  edit: { file: DocumentFile; operations: readonly DocumentEdit[] };
}
export interface DocumentResults {
  extract: ExtractedDocument;
  create: CreatedDocument;
  inspect: DocumentInspection;
  edit: CreatedDocument;
}
export type DocumentOperation = keyof DocumentRequests;
export type DocumentJob = { [K in DocumentOperation]: { operation: K; input: DocumentRequests[K] } }[DocumentOperation];
export type DocumentReply = { ok: true; result: unknown } | { ok: false; error: string };
