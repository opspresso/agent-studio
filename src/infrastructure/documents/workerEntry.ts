import { documentExtractor } from "@/infrastructure/llm/documentExtractor";
import { documentRenderer } from "./renderer";
import { documentEditor } from "./editor";
import { DocumentProcessingError } from "@/domain/document/processor";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import type { DocumentJob, DocumentReply } from "./workerProtocol";

/** One bounded job per child; no credentials, repository or network client is wired here. */
process.once("message", async (job: DocumentJob) => {
  let reply: DocumentReply;
  try {
    let result: unknown;
    switch (job.operation) {
      case "extract": result = await documentExtractor.extract(job.input); break;
      case "create": result = await documentRenderer.create(job.input); break;
      case "inspect": result = await documentEditor.inspect(job.input.file, job.input.options); break;
      case "edit": result = await documentEditor.edit(job.input.file, job.input.operations); break;
    }
    reply = { ok: true, result };
  } catch (error) {
    reply = { ok: false, error: error instanceof DocumentProcessingError || error instanceof DocumentExtractionError ? error.message : "Document processing failed" };
  }
  process.send?.(reply, () => process.disconnect?.());
});
process.once("disconnect", () => process.exit(0));
