import { z } from "zod";
import type { AguiRunInput } from "@/domain/agui/types";
import {
  base64Chars,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";

/**
 * The protocol's `RunAgentInput`, validated with this app's zod rather than
 * the SDK's (`src/domain/agui/types.ts` says why). Only the parts this
 * platform can act on are accepted: a user turn may carry text and images —
 * an audio, video or document part is refused as a 400 that names it, rather
 * than dropped into a run that then answers about an attachment it never saw.
 */

const LONGEST_ID = 256;

const toolCallSchema = z.object({
  id: z.string().min(1).max(LONGEST_ID),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});

const imageSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    value: z.string().max(base64Chars(MAX_ATTACHMENT_BYTES), "image payload is too large"),
    mimeType: z.enum(SUPPORTED_IMAGE_TYPES),
  }),
  z.object({
    type: z.literal("url"),
    value: z.string().startsWith("https://", "image url must be an https:// url"),
  }),
]);

const inputContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), source: imageSourceSchema }),
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
          (parts) => parts.filter((part) => part.type === "image").length <= MAX_ATTACHMENTS,
          `at most ${MAX_ATTACHMENTS} images per message`,
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
  messages: z.array(messageSchema).min(1),
  tools: z.array(toolSchema).default([]),
  context: z.array(contextSchema).default([]),
  state: z.unknown().optional(),
  forwardedProps: z.unknown().optional(),
});

