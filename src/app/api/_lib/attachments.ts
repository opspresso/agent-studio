import { z } from "zod";

/**
 * Inbound image attachment limits, shared by every surface that takes user
 * images (chat turns, project runs). The bytes arrive base64-encoded in a JSON
 * body, so the character cap is ~4/3 of the decoded size.
 */
export const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// Padded base64 length: 4 chars per 3-byte group, so a file at exactly the byte
// cap must still fit. Scaling the byte count by 4/3 rounds one char short of it.
const MAX_ATTACHMENT_CHARS = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3);
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const attachedImageSchema = z.object({
  b64: z.string().min(1).max(MAX_ATTACHMENT_CHARS, "image is larger than 5MB"),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
});

export const attachedImagesSchema = z.array(attachedImageSchema).max(MAX_ATTACHMENTS).optional();
