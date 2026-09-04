import { z } from "zod";
import type { AguiRunInput } from "@/domain/agui/types";
import {
  base64Chars,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import {
  documentKind,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_SIZE_LABEL,
  MAX_DOCUMENTS,
} from "@/domain/llm/documentLimits";

/**
 * The protocol's `RunAgentInput`, validated with this app's zod rather than
 * the SDK's (`src/domain/agui/types.ts` says why). Only the parts this
 * platform can act on are accepted: a user turn may carry text, images and
 * documents (a document as inline bytes of a type the extractor reads) — an
 * audio or video part, or a document by URL, is refused as a 400 that names
 * it, rather than dropped into a run that then answers about an attachment it
 * never saw.
 */

const LONGEST_ID = 256;

const toolCallSchema = z.object({
  id: z.string().min(1).max(LONGEST_ID),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const imageSourceSchema = z.object({
  type: z.literal("data"),
  value: z.string().max(base64Chars(MAX_IMAGE_BYTES), "image payload is too large"),
  mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
});

/** A name an application put in the open `metadata`; the mapping reads `name` or `filename`. */
const documentMetadataSchema = z.record(z.string(), z.unknown()).optional();

const documentPartSchema = z
  .object({
    type: z.literal("document"),
    source: z.object({
      type: z.literal("data"),
      value: z
        .string()
        .min(1)
        .max(
          base64Chars(MAX_DOCUMENT_BYTES),
          `document is larger than ${MAX_DOCUMENT_SIZE_LABEL}`,
        ),
      mimeType: z.string().max(255),
    }),
    metadata: documentMetadataSchema,
  })
  .refine(
    ({ source, metadata }) =>
      documentKind(
        source.mimeType,
        [metadata?.name, metadata?.filename].find((value) => typeof value === "string") as string | undefined,
      ) !== null,
    { message: "unsupported document type" },
  );

const inputContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), source: imageSourceSchema }),
  documentPartSchema,
]);

const baseMessage = { id: z.string().min(1).max(LONGEST_ID), name: z.string().optional() };

const messageSchema = z.discriminatedUnion("role", [
  z.object({ ...baseMessage, role: z.literal("developer"), content: z.string() }),
  z.object({ ...baseMessage, role: z.literal("system"), content: z.string() }),
  z.object({
    ...baseMessage,
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z
        .array(inputContentSchema)
        .refine(
          (parts) => parts.filter((part) => part.type === "image").length <= MAX_IMAGES_PER_TURN,
          `at most ${MAX_IMAGES_PER_TURN} images per message`,
        )
        .refine(
          (parts) => parts.filter((part) => part.type === "document").length <= MAX_DOCUMENTS,
          `at most ${MAX_DOCUMENTS} documents per message`,
        ),
    ]),
  }),
  z.object({
    ...baseMessage,
    role: z.literal("assistant"),
    content: z.string().optional(),
    toolCalls: z.array(toolCallSchema).optional(),
  }),
  z.object({
    id: z.string().min(1).max(LONGEST_ID),
    role: z.literal("tool"),
    content: z.string(),
    toolCallId: z.string().min(1).max(LONGEST_ID),
    error: z.string().optional(),
  }),
  z.object({ id: z.string().min(1).max(LONGEST_ID), role: z.literal("reasoning"), content: z.string() }),
  z.object({
    id: z.string().min(1).max(LONGEST_ID),
    role: z.literal("activity"),
    activityType: z.string(),
    content: z.record(z.string(), z.unknown()),
  }),
]);

/** A function name as providers accept it; anything else is rejected before a run is refused for it. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const toolSchema = z.object({
  name: z.string().regex(TOOL_NAME, "a tool name is 1–64 letters, digits, _ or -"),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const contextSchema = z.object({
  description: z.string().max(1_000),
  value: z.string().max(20_000),
});

export const runAgentInputSchema: z.ZodType<AguiRunInput> = z.object({
  threadId: z.string().min(1).max(LONGEST_ID),
  runId: z.string().min(1).max(LONGEST_ID),
  parentRunId: z.string().min(1).max(LONGEST_ID).optional(),
  // Empty is legal: the protocol's own schema allows it, and a programmatic
  // `runAgent()` may open a thread with nothing said yet.
  messages: z.array(messageSchema),
  tools: z.array(toolSchema).default([]),
  context: z.array(contextSchema).default([]),
  state: z.unknown().optional(),
  forwardedProps: z.unknown().optional(),
  // Interrupt/resume needs persisted interrupt state and this surface has no
  // such implementation. Refuse it explicitly instead of zod stripping it
  // and silently starting an unrelated fresh run.
  resume: z.never().optional(),
});
