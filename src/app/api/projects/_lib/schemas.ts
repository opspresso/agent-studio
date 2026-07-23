import { z } from "zod";

export const projectNameSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, "name must be a slug (lowercase letters, digits, hyphens)");

export const createProjectSchema = z.object({
  name: projectNameSchema,
  displayName: z.string().min(1),
  description: z.string().default(""),
  projectType: z.enum(["llm", "agent", "image"]),
  departmentCode: z.string().optional(),
});

export const updateProjectSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
  departmentCode: z.string().optional(),
});

export const versionParametersSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  piiFiltering: z.boolean().default(false),
  structuredOutput: z.boolean().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  imageGeneration: z.boolean().optional(),
  imageModel: z.string().optional(),
});

export const subagentRefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["local", "remote"]),
});

export const versionInputSchema = z.object({
  systemPrompt: z.string().default(""),
  userPromptTemplate: z.string().default(""),
  model: z.string().min(1),
  fallbackModel: z.string().optional(),
  parameters: versionParametersSchema.default({ piiFiltering: false }),
  mcpList: z.array(z.string()).default([]),
  skillList: z.array(z.string()).default([]),
  subagentList: z.array(subagentRefSchema).default([]),
  maxTurn: z.number().int().positive().optional(),
});

export const createVersionSchema = versionInputSchema.extend({
  versionName: z.string().min(1).optional(),
});

export const updateVersionSchema = versionInputSchema.partial();

export const publishSchema = z.object({ versionName: z.string().min(1) });

/** OpenAI-shaped chat message accepted on execution routes. */
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
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
