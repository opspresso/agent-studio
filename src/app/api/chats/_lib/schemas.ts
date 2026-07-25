import { z } from "zod";
import { attachedImagesSchema } from "@/app/api/_lib/attachments";

/** A turn needs words or a picture; an empty turn has nothing to answer. */
const hasSomethingToSay = (value: { content: string; images?: unknown[] }): boolean =>
  value.content.trim().length > 0 || (value.images?.length ?? 0) > 0;

export const createChatSchema = z
  .object({
    projectName: z.string().min(1),
    firstMessage: z.string().default(""),
    images: attachedImagesSchema,
  })
  .refine((value) => hasSomethingToSay({ content: value.firstMessage, images: value.images }), {
    message: "firstMessage or an image is required",
  });

export const sendMessageSchema = z
  .object({
    content: z.string().default(""),
    images: attachedImagesSchema,
  })
  .refine(hasSomethingToSay, { message: "content or an image is required" });
