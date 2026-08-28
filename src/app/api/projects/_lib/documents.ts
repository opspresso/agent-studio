import { readDocuments, turnContent, type ReadDocument } from "@/application/llm/documentParts";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { RunOrigin } from "@/domain/execution/actor";
import type { Version } from "@/domain/project/types";
import {
  openDocumentExtractor,
  type OpenDocumentExtractorDeps,
} from "@/application/execution/documentExtractor";

interface DocumentInput {
  b64: string;
  mimeType: string;
  name: string;
}

export async function readExecutionDocuments(
  extractor: DocumentExtractor,
  documents: DocumentInput[] = [],
): Promise<{ documents: ReadDocument[]; warnings: string[] }> {
  const warnings: string[] = [];
  const read = await readDocuments(
    extractor,
    documents.map((document) => ({
      bytes: Buffer.from(document.b64, "base64"),
      mimeType: document.mimeType,
      name: document.name,
    })),
    warnings,
  );
  return { documents: read, warnings };
}

export async function readBoundExecutionDocuments(
  deps: OpenDocumentExtractorDeps,
  version: Version,
  documents: DocumentInput[] = [],
  signal?: AbortSignal,
  origin?: Pick<RunOrigin, "conversation">,
): Promise<{ documents: ReadDocument[]; warnings: string[] }> {
  if (documents.length === 0) {
    return { documents: [], warnings: [] };
  }
  const opened = await openDocumentExtractor(deps, version, signal, origin);
  try {
    return await readExecutionDocuments(opened.extractor, documents);
  } finally {
    await opened.close();
  }
}

/** Put attached document text on the request's last user turn. */
export function attachDocumentsToMessages(
  messages: ChatMessageInput[],
  documents: ReadDocument[],
): ChatMessageInput[] {
  if (documents.length === 0) {
    return messages;
  }
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index < 0) {
    return [...messages, { role: "user", content: turnContent(documents, "") }];
  }
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index) {
      return message;
    }
    const content = message.content;
    return {
      ...message,
      content: Array.isArray(content)
        ? turnContent(documents, "", content)
        : turnContent(documents, content ?? ""),
    };
  });
}

/** Preserve pre-stream status, then surface extraction loss on the chunk channel. */
export async function* withDocumentWarnings(
  warnings: string[],
  source: AsyncGenerator<EngineChunk>,
): AsyncGenerator<EngineChunk> {
  const { value: first, done: sourceEnded } = await source.next();
  for (const warning of warnings) {
    yield { warning };
  }
  if (!sourceEnded) {
    yield first;
    yield* source;
  }
}
