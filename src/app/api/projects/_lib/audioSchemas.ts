import { z } from "zod";
import { isValidTimezone } from "@/domain/trigger/cron";

export const fileRetentionSchema = z.object({
  unit: z.enum(["days", "months"]), value: z.number().int().positive(),
  timezone: z.string().min(1).max(100).refine(isValidTimezone, "Invalid timezone"),
}).strict();

export const sourceReferenceSchema = z.object({
  url: z.string().min(1).max(8192), namespace: z.string().min(1).max(128), itemId: z.string().min(1).max(512),
  filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(128),
}).strict();

export const audioJobSchema = z.object({
  task: z.enum(["import", "transcribe", "process"]).optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), fileId: z.string().min(1).max(128) }).strict(),
    z.object({ kind: z.literal("source"), sourceRef: z.string().min(1).max(128) }).strict(),
  ]),
  model: z.string().min(1).max(256).optional(), language: z.string().regex(/^[a-z]{2,3}$/i).optional(),
  processingRevision: z.string().min(1).max(128).optional(), retention: fileRetentionSchema,
  postprocess: z.object({ projectName: z.string().min(1).max(128), versionName: z.string().min(1).max(128) }).strict().optional(),
  destination: z.object({ serverName: z.string().min(1).max(128), documents: z.boolean(), memories: z.boolean() }).strict().optional(),
}).strict();

export const audioJobActionSchema = z.object({ action: z.enum(["cancel", "retry"]), revision: z.number().int().positive() }).strict();
