import { readDocuments, turnContent, type ReadDocument } from "@/application/llm/documentParts";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { ChatMessageInput } from "@/domain/llm/types";
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
