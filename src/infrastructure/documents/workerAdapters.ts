import type { DocumentRenderer, DocumentEditor } from "@/domain/document/processor";
import { DocumentProcessingError } from "@/domain/document/processor";
import { DocumentExtractionError, type DocumentExtractor } from "@/domain/llm/documentExtractor";
import { DocumentWorkerPool } from "./workerPool";

const globals = globalThis as typeof globalThis & { agentStudioDocumentWorkers?: DocumentWorkerPool };
function pool(): DocumentWorkerPool {
  return globals.agentStudioDocumentWorkers ??= new DocumentWorkerPool();
}

export const workerDocumentExtractor: DocumentExtractor = {
  async extract({ signal, ...input }) {
    try { return await pool().execute("extract", input, signal); } catch (error) {
      if (error instanceof DocumentProcessingError) throw new DocumentExtractionError(error.message);
      throw error;
    }
  },
};
export const workerDocumentRenderer: DocumentRenderer = {
  create: (input, signal) => pool().execute("create", input, signal),
};
export const workerDocumentEditor: DocumentEditor = {
  inspect: (file, options, signal) => pool().execute("inspect", { file, options }, signal),
  edit: (file, operations, signal) => pool().execute("edit", { file, operations }, signal),
};
