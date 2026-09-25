import { z } from "zod";
import { attachedDocumentsSchema, attachedImagesSchema } from "@/app/api/_lib/attachments";

/** A turn needs words or an attachment; an empty turn has nothing to answer. */
const hasSomethingToSay = (value: {
  content: string;
  images?: unknown[];
  documents?: unknown[];
}): boolean =>
  value.content.trim().length > 0 ||
  (value.images?.length ?? 0) > 0 ||
  (value.documents?.length ?? 0) > 0;

export const createChatSchema = z
  .object({
    agentName: z.string().min(1),
    firstMessage: z.string().default(""),
    images: attachedImagesSchema,
    documents: attachedDocumentsSchema,
  })
  .refine(
    (value) =>
      hasSomethingToSay({
        content: value.firstMessage,
        images: value.images,
        documents: value.documents,
      }),
    { message: "firstMessage or an attachment is required" },
  );

/**
 * A run id comes off the URL and ends up composed into a sort key, so it is
 * checked for shape before it is used as one. `claimChatRun` mints these with
 * `randomUUID`, and nothing else may name a run.
 */
export const runIdSchema = z.uuid();

export const sendMessageSchema = z
  .object({
    content: z.string().default(""),
    images: attachedImagesSchema,
    documents: attachedDocumentsSchema,
  })
  .refine(hasSomethingToSay, { message: "content or an attachment is required" });
