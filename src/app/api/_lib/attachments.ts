import { z } from "zod";
import {
  base64Chars,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";

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
