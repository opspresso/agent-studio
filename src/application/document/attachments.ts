import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import { documentKind, MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";
import { savedFileName } from "@/domain/artifact/types";
import { storeArtifact, type ArtifactContext, type ArtifactStorage } from "@/application/artifact/storeArtifact";
import { readDocuments, withinDocumentCount, type AttachedDocument, type ReadDocument } from "@/application/llm/documentParts";
import { log } from "@/shared/logger";

/** Keep originals outside message rows, then extract the bounded text a turn carries. */
export async function prepareDocumentAttachments(
  extractor: DocumentExtractor,
  storage: ArtifactStorage | undefined,
  context: ArtifactContext,
  documents: AttachedDocument[],
): Promise<{ stored: ReadDocument[]; warnings: string[] }> {
  const warnings: string[] = [];
  const accepted: AttachedDocument[] = [];
  for (const document of withinDocumentCount(documents, warnings)) {
    if (document.bytes.byteLength > MAX_DOCUMENT_BYTES || documentKind(document.mimeType, document.name) === null) {
      warnings.push(`Could not attach ${document.name}: unsupported document type or size.`);
      continue;
    }
    // References supplied by a caller are never trusted as proof that these bytes were stored.
    const input: AttachedDocument = { bytes: document.bytes, mimeType: document.mimeType, name: document.name };
    if (storage) {
      try {
        const artifact = await storeArtifact(storage, context, {
          kind: "document", source: "attachment", bytes: input.bytes,
          mimeType: input.mimeType,
          filename: savedFileName(input.name, "application/octet-stream"),
        });
        input.file = {
          artifactId: artifact.artifactId, key: artifact.key,
          name: artifact.filename!, mimeType: artifact.mimeType, byteSize: artifact.byteSize,
        };
      } catch (error) {
        log.error("artifact", "could not store an attached document", error);
        warnings.push(`The original of ${input.name} could not be stored; it cannot be reopened or edited later.`);
      }
    } else {
      warnings.push(`The original of ${input.name} is not kept because file storage is not configured.`);
    }
    accepted.push(input);
  }
  const stored = await readDocuments(extractor, accepted, warnings);
  return { stored, warnings };
}
