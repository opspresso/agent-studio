import { z } from "zod";
import { isSlug, SLUG_RULE } from "@/shared/slug";
import { attachedImagesSchema } from "@/app/api/_lib/attachments";
import type { ChannelToolCall } from "@/domain/llm/types";
import type { McpBinding } from "@/domain/project/types";

export const projectNameSchema = z
  .string()
  .refine(isSlug, `name ${SLUG_RULE}`);

export const createProjectSchema = z.object({
  name: projectNameSchema,
  displayName: z.string().min(1),
  description: z.string().default(""),
  projectType: z.enum(["llm", "agent", "image"]),
  departmentCode: z.string().max(64).optional(),
});

const messageDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack"), channelId: z.string().trim().min(1) }),
  z.object({
    kind: z.literal("telegram"),
    chatId: z.number().int().safe().refine((chatId) => chatId !== 0, "chatId must not be zero"),
    threadId: z.number().int().positive().safe().optional(),
  }),
  z.object({ kind: z.literal("teams"), conversationId: z.string().trim().min(1) }),
]);
const messageDestinationsSchema = z
  .array(messageDestinationSchema)
  .max(3)
  .refine(
    (destinations) =>
      new Set(destinations.map((destination) => destination.kind)).size === destinations.length,
    "A messaging platform may be selected only once",
  );

/**
 * Daily and monthly spend guards. Sent whole: the object replaces whatever was
 * stored, and `null` clears the guard entirely. A partial merge would make
 * "remove the block threshold but keep the alert" unexpressible without a
 * second verb.
 */
export const costLimitsSchema = z
  .object({
    alertThresholdUsd: z.number().positive().optional(),
    blockThresholdUsd: z.number().positive().optional(),
    monthlyAlertThresholdUsd: z.number().positive().optional(),
    monthlyBlockThresholdUsd: z.number().positive().optional(),
    alertDestinations: messageDestinationsSchema.optional(),
    alertSlackChannel: z.string().min(1).optional(),
  })
  .refine(
    (limits) =>
      limits.alertThresholdUsd === undefined ||
      limits.blockThresholdUsd === undefined ||
      limits.alertThresholdUsd <= limits.blockThresholdUsd,
    {
      // Above the block threshold the alert can never fire on its own: the block
      // stops the spending that would have reached it.
      message: "alertThresholdUsd must not exceed blockThresholdUsd",
      path: ["alertThresholdUsd"],
    },
  )
  .refine(
    (limits) =>
      limits.monthlyAlertThresholdUsd === undefined ||
      limits.monthlyBlockThresholdUsd === undefined ||
      limits.monthlyAlertThresholdUsd <= limits.monthlyBlockThresholdUsd,
    {
      message: "monthlyAlertThresholdUsd must not exceed monthlyBlockThresholdUsd",
      path: ["monthlyAlertThresholdUsd"],
    },
  );

export const updateProjectSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  departmentCode: z.string().max(64).optional(),
  costLimits: costLimitsSchema.nullable().optional(),
});

/** Trigger payload handling; see `TriggerPayloadMode`. */
const payloadModeSchema = z.enum(["variables", "message"]);

// Cron/timezone validity and which kind may carry which field are enforced in
// `triggerUseCases` — the rules live beside the code that reads them.
export const createTriggerSchema = z.object({
  triggerId: z
    .string()
    .refine(isSlug, `triggerId ${SLUG_RULE}`),
  kind: z.enum(["webhook", "schedule"]).optional(),
  description: z.string().default(""),
  enabled: z.boolean().optional(),
  variables: z.record(z.string().min(1), z.string()).optional(),
  payloadMode: payloadModeSchema.optional(),
  allowConcurrent: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  message: z.string().optional(),
  deliveries: messageDestinationsSchema.optional(),
});

export const updateTriggerSchema = z.object({
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  variables: z.record(z.string().min(1), z.string()).optional(),
  payloadMode: payloadModeSchema.optional(),
  allowConcurrent: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  message: z.string().optional(),
  deliveries: messageDestinationsSchema.optional(),
});

export const versionParametersSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  piiFiltering: z.boolean().default(false),
  callerContext: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  imageGeneration: z.boolean().optional(),
  urlFetch: z.boolean().optional(),
  slackWorkspace: z.boolean().optional(),
  imageModel: z.string().optional(),
  dynamicCapabilities: z.boolean().optional(),
  memoryRecall: z.boolean().optional(),
});

export const subagentRefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["local", "remote"]),
});

/**
 * An MCP binding. A bare string stays accepted — that was the whole shape
 * before per-version header overrides — and normalizes to a binding with none.
 * In the object form, a `null` header value removes a registry default.
 */
export const mcpBindingSchema: z.ZodType<McpBinding> = z.union([
  z.string().min(1).transform((name): McpBinding => ({ name })),
  z.object({
    name: z.string().min(1),
    headers: z.record(z.string().min(1), z.string().nullable()).optional(),
    /** Omitted or empty means "every tool this server offers". */
    tools: z.array(z.string().min(1)).optional(),
  }),
]);

export const versionInputSchema = z.object({
  systemPrompt: z.string().default(""),
  userPromptTemplate: z.string().default(""),
  model: z.string().min(1),
  fallbackModel: z.string().optional(),
  parameters: versionParametersSchema.default({ piiFiltering: false }),
  mcpList: z.array(mcpBindingSchema).default([]),
  skillList: z.array(z.string()).default([]),
  subagentList: z.array(subagentRefSchema).default([]),
  maxTurn: z.number().int().positive().optional(),
});

export const versionNameSchema = z
  .string()
  .refine(isSlug, `versionName ${SLUG_RULE}`)
  .refine((name) => name !== "published", {
    message: '"published" is reserved for the published-version pointer',
  });

export const createVersionSchema = versionInputSchema.extend({
  versionName: versionNameSchema.optional(),
});

export const updateVersionSchema = versionInputSchema.partial().extend({
  fallbackModel: z.string().nullable().optional(),
  maxTurn: z.number().int().positive().nullable().optional(),
});

export const publishSchema = z.object({ versionName: z.string().min(1) });

/**
 * A version as it stands in the editor, plus the variables to render its
 * template with. The body carries the whole draft rather than a version name
 * because the point of the preview is to see what is *not saved yet*.
 *
 * `versionName` is the exception, and it is not the draft's identity: it names
 * the saved version the editor started from, so that masked header overrides
 * can be resolved back to the secrets they stand for. A form reads them masked
 * and echoes them back, and a mask is not a credential — without this the
 * preview dials the bound MCP servers with the wrong headers. Absent for a
 * version that was never saved, which has nothing to resolve against.
 */
export const previewPromptSchema = versionInputSchema.extend({
  versionName: z.string().min(1).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  /**
   * A request to preview against. Only capability discovery reads it — the
   * assembled prompt still stands before the first turn — so it is bounded at
   * the length a query is useful at rather than a whole conversation's.
   */
  message: z.string().max(8000).optional(),
});

/**
 * Cap on one inline image payload. A data URL is ~1 char per byte, so this
 * bounds a request that carries images to a few of them at a few MB each.
 */
const MAX_IMAGE_URL_CHARS = 10 * 1024 * 1024;

/**
 * One OpenAI content part. Image bytes arrive inline as `data:image/…;base64,…`;
 * a remote image must be https (the provider fetches it, so no other scheme is
 * useful and `file:`-style urls are never intended).
 */
const contentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z
        .string()
        .max(MAX_IMAGE_URL_CHARS, "image payload is too large")
        .refine(
          (url) => url.startsWith("data:image/") || url.startsWith("https://"),
          "image url must be a data:image/… or https:// url",
        ),
      detail: z.enum(["low", "high", "auto"]).optional(),
    }),
  }),
]);

/** OpenAI-shaped chat message accepted on execution routes. */
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.custom<ChannelToolCall>()).optional(),
  tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
});

export const predictSchema = z.object({
  variables: z.record(z.string(), z.string()).optional(),
  messages: z.array(chatMessageSchema).optional(),
  stream: z.boolean().optional(),
  prompt: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  /** Source images for an `image` project: present means edit, absent means draw. */
  images: attachedImagesSchema,
});

export const chatCompletionsSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1),
  variables: z.record(z.string(), z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export const agentSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
});
