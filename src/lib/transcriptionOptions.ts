import { z } from "zod";
import { MAX_AUDIO_SECONDS } from "@/domain/audio/limits";
const optionsSchema = z.object({
  responseFormat: z.enum(["json", "verbose_json", "diarized_json"]).optional(),
  chunkingStrategy: z.literal("auto").optional(),
  providerOptions: z.record(z.string().regex(/^[a-z0-9_-]{1,64}$/), z.record(z.string(), z.unknown())).optional(),
  timestampGranularities: z.array(z.enum(["segment", "word"])).min(1).max(2).optional(),
  preferOriginal: z.boolean().optional(),
  segmentSeconds: z.number().int().positive().max(MAX_AUDIO_SECONDS).optional(),
}).strict();
export type TranscriptionModelOptions = z.infer<typeof optionsSchema>;
const schema = z.record(z.string().min(1).max(200), optionsSchema);

/** Deployment-owned per-model protocol settings; never log operator JSON on errors. */
export function parseTranscriptionModelOptions(value: string | undefined): Record<string, TranscriptionModelOptions> {
  if (!value?.trim()) return {};
  try {
    if (Buffer.byteLength(value) > 16 * 1024) throw new Error("Too much configuration");
    return schema.parse(JSON.parse(value));
  } catch { throw new Error("Invalid TRANSCRIPTION_MODEL_OPTIONS"); }
}
