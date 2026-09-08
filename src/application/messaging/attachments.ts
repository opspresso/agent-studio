import { prepareDocumentAttachments } from "@/application/document/attachments";
import type { ArtifactStorage, ArtifactContext } from "@/application/artifact/storeArtifact";
import type { HistoryTurn, InboundAttachment } from "@/domain/messaging/inbound";
import { DocumentExtractionError, type DocumentExtractor } from "@/domain/llm/documentExtractor";
import { imageDataUrl } from "@/domain/llm/types";
import type { ChatMessageInput, ContentPart } from "@/domain/llm/types";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIZE_LABEL,
  MAX_IMAGES_PER_TURN,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import {
  documentKind,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_SIZE_LABEL,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_CHARS_PER_TURN,
} from "@/domain/llm/documentLimits";
import {
  readDocuments as readDocumentsFor,
  withinDocumentCount,
  type AttachedDocument,
  type ReadDocument,
  turnContent,
} from "@/application/llm/documentParts";
import { log } from "@/shared/logger";
import { sniffImageType } from "@/domain/llm/imageSniff";

/**
 * How a messaging surface's attachments become a turn's content — the one
 * copy of the limits, the order they are checked in, and the sentence each
 * dropped file earns.
 *
 * Every surface that takes attachments from a chat platform makes the same
 * decisions: which files are pictures and which are documents, how many of
 * each a turn may carry, how large one may be, and what to say about the ones
 * it could not use. The platform contributes only the bytes, through
 * {@link InboundAttachment.download}. Anything dropped is reported, never
 * silently skipped.
 */

const SUPPORTED_TYPES = new Set<string>(SUPPORTED_IMAGE_TYPES);
/**
 * How many recent turns are searched for images. A conversation can be long
 * and its pictures are re-downloaded and re-encoded on every message, so only
 * the recent context is worth that cost.
 */
const HISTORY_IMAGE_LOOKBACK = 10;

function isImage(attachment: InboundAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

/**
 * A platform that says "a picture" without saying which kind — Teams marks a
 * pasted image `image/*`. The bytes are asked instead, once they are in hand.
 */
function isUnspecifiedImage(attachment: InboundAttachment): boolean {
  return attachment.mimeType === "image/*" || attachment.mimeType === "image";
}

/**
 * Download image attachments as content parts, up to `budget` images. Callers
 * spend the budget on the current message first, then on the newest history.
 */
export async function collectImageParts(
  attachments: InboundAttachment[],
  warnings: string[],
  budget = MAX_IMAGES_PER_TURN,
): Promise<ContentPart[]> {
  if (budget <= 0) {
    return [];
  }
  const images = attachments.filter(isImage);
  // Only files nothing here can read. Documents are counted out because they
  // have their own path; calling them "ignored" while they were being read
  // would report a loss that did not happen.
  const unreadable = attachments.filter(
    (attachment) => !isImage(attachment) && documentKind(attachment.mimeType, attachment.name) === null,
  );
  if (unreadable.length > 0) {
    warnings.push(
      `Ignored ${unreadable.length} attachment(s): neither an image nor a readable document.`,
    );
  }
  if (images.length > budget) {
    warnings.push(`Read only ${budget} of ${images.length} attached images.`);
  }

  const parts: ContentPart[] = [];
  for (const image of images.slice(0, budget)) {
    const label = image.name;
    if (!isUnspecifiedImage(image) && !SUPPORTED_TYPES.has(image.mimeType)) {
      warnings.push(`Unsupported image type ${image.mimeType} (${label}).`);
      continue;
    }
    if ((image.size ?? 0) > MAX_IMAGE_BYTES) {
      warnings.push(`Image is larger than ${MAX_IMAGE_SIZE_LABEL} (${label}).`);
      continue;
    }
    if (!image.download) {
      warnings.push(`Attachment has no download url (${label}).`);
      continue;
    }
    try {
      const data = await image.download(MAX_IMAGE_BYTES);
      // A platform's declared size can be absent, so the download is bounded
      // too; this is the same limit restated where the bytes are finally in hand.
      if (data.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`Image is larger than ${MAX_IMAGE_SIZE_LABEL} (${label}).`);
        continue;
      }
      const mimeType = isUnspecifiedImage(image) ? sniffImageType(data) : image.mimeType;
      if (!mimeType) {
        warnings.push(`Unsupported image type (${label}).`);
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: { url: imageDataUrl({ b64: data.toString("base64"), mimeType }) },
      });
    } catch (error) {
      log.error("messaging", "attachment download failed", error);
      warnings.push(
        `Could not read attachment ${label}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return parts;
}

/**
 * Download the message's document attachments and read them into text.
 *
 * The caller selects the message and reserves its share of the run's budget.
 */
export interface DocumentPersistence { storage?: ArtifactStorage; context: ArtifactContext }

export async function collectDocuments(
  documents: DocumentExtractor,
  attachments: InboundAttachment[],
  warnings: string[],
  persistence?: DocumentPersistence,
): Promise<ReadDocument[]> {
  const candidates = attachments.filter(
    (attachment) => documentKind(attachment.mimeType, attachment.name) !== null,
  );
  if (candidates.length === 0) {
    return [];
  }
  const downloaded: AttachedDocument[] = [];
  // Capped before anything is fetched: past the cap these are bytes nobody will
  // read, and each one may be 10MB through the bot's credentials.
  for (const document of withinDocumentCount(candidates, warnings)) {
    const label = document.name;
    if ((document.size ?? 0) > MAX_DOCUMENT_BYTES) {
      warnings.push(`Document is larger than ${MAX_DOCUMENT_SIZE_LABEL} (${label}).`);
      continue;
    }
    if (!document.download) {
      warnings.push(`Attachment has no download url (${label}).`);
      continue;
    }
    try {
      const data = await document.download(MAX_DOCUMENT_BYTES);
      if (data.byteLength > MAX_DOCUMENT_BYTES) {
        warnings.push(`Document is larger than ${MAX_DOCUMENT_SIZE_LABEL} (${label}).`);
        continue;
      }
      downloaded.push({ bytes: data, mimeType: document.mimeType, name: label });
    } catch (error) {
      log.error("messaging", "document download failed", error);
      warnings.push(
        `Could not read attachment ${label}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  if (persistence) {
    const result = await prepareDocumentAttachments(documents, persistence.storage, persistence.context, downloaded);
    warnings.push(...result.warnings);
    return result.stored;
  }
  return readDocumentsFor(documents, downloaded, warnings);
}

export async function withHistoryDocuments(
  extractor: DocumentExtractor,
  turns: HistoryTurn[],
  currentAttachments: InboundAttachment[],
  currentDocuments: ReadDocument[],
  warnings: string[],
  persistence?: DocumentPersistence,
): Promise<HistoryTurn[]> {
  const isDocument = (attachment: InboundAttachment) => documentKind(attachment.mimeType, attachment.name) !== null;
  let remainingCount = Math.max(0, MAX_DOCUMENTS - currentAttachments.filter(isDocument).length);
  let remainingChars = MAX_DOCUMENT_CHARS_PER_TURN - currentDocuments.reduce((sum, document) => sum + document.text.length, 0);
  const bounded: DocumentExtractor = {
    extract: async (input) => {
      if (remainingChars <= 0) {
        throw new DocumentExtractionError("this run's document budget is spent");
      }
      const result = await extractor.extract({ ...input, maxChars: Math.min(input.maxChars, remainingChars) });
      remainingChars -= result.text.length;
      return result;
    },
  };
  const readByIndex = new Map<number, ReadDocument[]>();
  let dropped = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.message.role !== "user") {
      continue;
    }
    const candidates = turn.attachments.filter(isDocument);
    const selected = remainingChars > 0 ? candidates.slice(0, remainingCount) : [];
    remainingCount -= selected.length;
    dropped += candidates.length - selected.length;
    if (selected.length > 0) {
      readByIndex.set(index, await collectDocuments(bounded, selected, warnings, persistence));
    }
  }
  if (dropped > 0) {
    warnings.push(`Left out ${dropped} older document attachment(s) to fit this run's document budget.`);
  }
  return turns.map((turn, index) => {
    const documents = readByIndex.get(index);
    if (!documents?.length) {
      return turn;
    }
    const content = turn.message.content;
    return {
      ...turn,
      message: {
        ...turn.message,
        content: turnContent(documents, typeof content === "string" ? content : "", Array.isArray(content) ? content : []),
      },
    };
  });
}

/**
 * Attach the images of earlier turns to their own messages, newest turn first
 * until the budget runs out. Without this an "edit the picture I sent earlier"
 * request would reach the model as text alone.
 */
export async function withHistoryImages(
  turns: HistoryTurn[],
  budget: number,
  warnings: string[],
): Promise<ChatMessageInput[]> {
  const partsByIndex = new Map<number, ContentPart[]>();
  let remaining = budget;
  const oldest = Math.max(0, turns.length - HISTORY_IMAGE_LOOKBACK);
  for (let index = turns.length - 1; index >= oldest && remaining > 0; index -= 1) {
    const turn = turns[index];
    // Only a human turn's images are input. The bot's own uploads would come back
    // as `image_url` parts on an *assistant* message — a shape OpenAI-compatible
    // providers reject — and would spend the budget on pictures this run drew.
    if (turn?.message.role !== "user") {
      continue;
    }
    // Only image attachments are relevant here, and an older turn's unrelated
    // files are not worth reporting on — the user is asking about this turn.
    const images = (turn?.attachments ?? []).filter(isImage);
    if (images.length === 0) {
      continue;
    }
    const parts = await collectImageParts(images, warnings, remaining);
    if (parts.length > 0) {
      partsByIndex.set(index, parts);
      remaining -= parts.length;
    }
  }

  return turns.map((turn, index) => {
    const parts = partsByIndex.get(index);
    if (!parts) {
      return turn.message;
    }
    const text = typeof turn.message.content === "string" ? turn.message.content : "";
    return {
      ...turn.message,
      content: [...(text ? [{ type: "text" as const, text }] : []), ...parts],
    };
  });
}
