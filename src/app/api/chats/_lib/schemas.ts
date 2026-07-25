import { z } from "zod";

/**
 * Attachment limits for a chat turn. The bytes arrive base64-encoded in the JSON
 * body, so the character cap is ~4/3 of the decoded size.
 */
export const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3);
const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const attachedImageSchema = z.object({
  b64: z.string().min(1).max(MAX_ATTACHMENT_CHARS, "image is larger than 5MB"),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
});

const imagesSchema = z.array(attachedImageSchema).max(MAX_ATTACHMENTS).optional();

/** A turn needs words or a picture; an empty turn has nothing to answer. */
const hasSomethingToSay = (value: { content: string; images?: unknown[] }): boolean =>
  value.content.trim().length > 0 || (value.images?.length ?? 0) > 0;

export const createChatSchema = z
  .object({
    projectName: z.string().min(1),
    firstMessage: z.string().default(""),
    images: imagesSchema,
  })
  .refine((value) => hasSomethingToSay({ content: value.firstMessage, images: value.images }), {
    message: "firstMessage or an image is required",
  });

export const sendMessageSchema = z
  .object({
    content: z.string().default(""),
    images: imagesSchema,
  })
  .refine(hasSomethingToSay, { message: "content or an image is required" });
