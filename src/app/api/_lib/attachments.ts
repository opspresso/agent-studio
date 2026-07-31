import { z } from "zod";
import {
  base64Chars,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import {
  documentKind,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
} from "@/domain/llm/documentLimits";

/**
 * Inbound image attachment bodies (chat turns, project runs). The caps live in
 * `@/domain/llm/imageLimits`; the bytes arrive base64-encoded in JSON, so the
 * byte cap becomes a character cap here.
 */
const MAX_ATTACHMENT_CHARS = base64Chars(MAX_ATTACHMENT_BYTES);

export const attachedImageSchema = z.object({
  b64: z.string().min(1).max(MAX_ATTACHMENT_CHARS, "image is larger than 5MB"),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
});

export const attachedImagesSchema = z.array(attachedImageSchema).max(MAX_ATTACHMENTS).optional();

const MAX_DOCUMENT_B64_CHARS = base64Chars(MAX_DOCUMENT_BYTES);

/**
 * Inbound document bodies. The type is not an enum, unlike an image's: uploads
 * arrive labelled `application/octet-stream` often enough that a strict list
 * would reject files people actually attached. `documentKind` is the gate — the
 * same one the extractor and Slack ask — and it gets the name too, because for
 * an unlabelled file the extension is the only thing that says what it is.
 */
export const attachedDocumentSchema = z
  .object({
    b64: z.string().min(1).max(MAX_DOCUMENT_B64_CHARS, "document is larger than 10MB"),
    mimeType: z.string().max(255),
    name: z.string().min(1).max(255),
  })
  .refine(({ mimeType, name }) => documentKind(mimeType, name) !== null, {
    message: "unsupported document type",
  });

export const attachedDocumentsSchema = z
  .array(attachedDocumentSchema)
  .max(MAX_DOCUMENTS)
  .optional();
