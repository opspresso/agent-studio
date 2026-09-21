import { z } from "zod";
import { PRESENCE_PENALTY_RANGE } from "@/domain/llm/channel";
import { isMcpSourceMapping, MAX_MCP_SOURCE_MAPPINGS } from "@/domain/mcp/sourceMapping";
import { isSlug, SLUG_RULE } from "@/domain/naming";
import { attachedDocumentsSchema } from "@/app/api/_lib/attachments";
import {
  isInlineImageDataUrl,
  MAX_IMAGE_SIZE_LABEL,
  MAX_IMAGES_PER_TURN,
} from "@/domain/llm/imageLimits";
import type { ChannelToolCall } from "@/domain/llm/types";
import type { McpBinding } from "@/domain/project/types";

export const projectNameSchema = z
  .string()
  .refine(isSlug, `name ${SLUG_RULE}`);

export const cloneProjectSchema = z.object({
  name: projectNameSchema,
  displayName: z.string().min(1),
});

export const createProjectSchema = z.object({
  name: projectNameSchema,
  displayName: z.string().min(1),
  description: z.string().default(""),
  projectType: z.literal("agent").default("agent"),
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
  visibility: z.enum(["public", "private"]).optional(),
  // Replaces the stored invite list; normalization (trim, lowercase, dedupe,
  // owner dropped) happens in the use case beside the rule that reads it.
  memberEmails: z.array(z.string().trim().email()).max(200).optional(),
});

// Cron/timezone validity and which kind may carry which field are enforced in
// `triggerUseCases` — the rules live beside the code that reads them.
export const createTriggerSchema = z.object({
  runAsOwner: z.boolean().optional(),
  triggerId: z
    .string()
    .refine(isSlug, `triggerId ${SLUG_RULE}`),
  kind: z.enum(["webhook", "schedule"]).optional(),
  description: z.string().default(""),
  enabled: z.boolean().optional(),
  allowConcurrent: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  message: z.string().optional(),
  deliveries: messageDestinationsSchema.optional(),
}).strict();

export const updateTriggerSchema = z.object({
  runAsOwner: z.boolean().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  allowConcurrent: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  message: z.string().optional(),
  deliveries: messageDestinationsSchema.optional(),
}).strict();

export const agentParametersSchema = z.object({
  policy: z.object({
    maxInputChars: z.number().int().min(1).max(1_000_000).optional(),
    blockedTools: z.array(z.string().min(1).max(64)).max(128).optional(),
    approvalTools: z.array(z.string().min(1).max(64).refine((name) => !name.startsWith("handoff_"), "Require approval for delegate tools or actions, not handoffs")).max(128).optional(),
  }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  presencePenalty: z.number().min(PRESENCE_PENALTY_RANGE.min).max(PRESENCE_PENALTY_RANGE.max).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  piiFiltering: z.boolean().default(false),
  callerContext: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  imageGeneration: z.boolean().optional(),
  urlFetch: z.boolean().optional(),
  audioProcessing: z.boolean().optional(),
  workspaceTools: z.boolean().optional(),
  slackWorkspace: z.boolean().optional(),
  imageModel: z.string().optional(),
  dynamicCapabilities: z.boolean().optional(),
  memoryRecall: z.boolean().optional(),
  reasoningTrace: z.boolean().optional(),
});

export const subagentRefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["local", "remote"]),
});

/**
 * An MCP binding. A bare server name normalizes to a binding without overrides.
 * In the object form, a `null` header value removes a registry default.
 */
export const mcpBindingSchema: z.ZodType<McpBinding> = z.union([
  z.string().min(1).transform((name): McpBinding => ({ name })),
  z.object({
    name: z.string().min(1),
    headers: z.record(z.string().min(1), z.string().nullable()).optional(),
    /** Omitted or empty means "every tool this server offers". */
    tools: z.array(z.string().min(1)).optional(),
    sourceOutputs: z.array(z.object({
      refreshArgument: z.string().min(1).max(128).optional(),
      tool: z.string().min(1).max(128), namespace: z.string().min(1).max(128),
      urlPath: z.array(z.string().min(1).max(128)).min(1).max(8),
      idPath: z.array(z.string().min(1).max(128)).min(1).max(8),
      namePath: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
      mimeType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/i),
    }).strict().refine(isMcpSourceMapping, "Invalid source mapping")).max(MAX_MCP_SOURCE_MAPPINGS).refine((items) => new Set(items.map((item) => item.tool)).size === items.length, "Duplicate source tool mapping").optional(),
  }),
]);

export const agentConfigurationInputSchema = z.object({
  systemPrompt: z.string().default(""),
  model: z.string().min(1),
  fallbackModel: z.string().optional(),
  parameters: agentParametersSchema.default({ piiFiltering: false }),
  mcpList: z.array(mcpBindingSchema).default([]),
  skillList: z.array(z.string()).default([]),
  subagentList: z.array(subagentRefSchema).default([]),
  maxTurn: z.number().int().positive().optional(),
});

export const putAgentConfigurationSchema = agentConfigurationInputSchema.extend({
  expectedUpdatedAt: z.string().datetime(),
}).strict();

export const previewPromptSchema = agentConfigurationInputSchema.extend({
  message: z.string().max(8000).optional(),
}).strict();

/**
 * One OpenAI content part. Image bytes arrive inline as `data:image/…;base64,…`;
 * remote URLs are refused so a provider never fetches a caller-controlled host.
 */
const contentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z
        .string()
        .refine(
          isInlineImageDataUrl,
          `image must be a supported data:image/…;base64,… payload no larger than ${MAX_IMAGE_SIZE_LABEL}`,
        ),
      detail: z.enum(["low", "high", "auto"]).optional(),
    }),
  }),
]);

/**
 * A replayed tool call, with the domain type's optionality — every field can
 * be absent mid-accumulation. A real schema rather than `z.custom`, which
 * with no check function passes anything and lets a non-object wear the type.
 */
const channelToolCallSchema: z.ZodType<ChannelToolCall> = z.object({
  index: z.number().int().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  function: z
    .object({ name: z.string().optional(), arguments: z.string().optional() })
    .optional(),
});

/** OpenAI-shaped chat message accepted on execution routes. */
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(channelToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
}).refine(
  ({ content }) =>
    !Array.isArray(content) ||
    content.filter((part) => part.type === "image_url").length <= MAX_IMAGES_PER_TURN,
  { message: `at most ${MAX_IMAGES_PER_TURN} images per message`, path: ["content"] },
);

export const predictSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  documents: attachedDocumentsSchema,
}).strict();

export const chatCompletionsSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export const agentSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  documents: attachedDocumentsSchema,
});
