import { z } from "zod";
import {
  TranscriptionError,
  validateTranscription,
  type TranscriptionPort,
  type TranscriptionUsage,
} from "@/domain/llm/transcription";
import { readBodyText } from "@/shared/httpBody";

export interface TranscriptionConfig {
  baseUrl: string;
  apiKey?: string;
  id: string;
  wireId: string;
  maxInputBytes: number;
  responseFormat?: "json" | "verbose_json" | "diarized_json";
  chunkingStrategy?: "auto";
}

/** Bounds one provider request, independently of the worker's total job lifetime. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const nonnegative = z.number().finite().nonnegative();
const tokens = nonnegative.int().max(Number.MAX_SAFE_INTEGER);
const responseSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  segments: z.array(z.object({
    text: z.string(),
    start: nonnegative.optional(),
    end: nonnegative.optional(),
    speaker: z.string().min(1).optional(),
  })).optional(),
  usage: z.object({
    type: z.string().optional(),
    input_tokens: tokens.optional(),
    output_tokens: tokens.optional(),
    seconds: nonnegative.optional(),
  }).optional(),
});

function normalizeResponse(body: unknown, config: TranscriptionConfig) {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    // Validation errors may contain provider content; only expose the contract failure.
    throw new TranscriptionError("invalid_response", "Transcription response does not match the expected schema");
  }
  const value = parsed.data;
  if (value.model !== undefined && value.model !== config.wireId && value.model !== config.id) {
    throw new TranscriptionError("invalid_response", "Transcription response reports a different model");
  }
  const usage: TranscriptionUsage = {
    ...(value.usage?.input_tokens !== undefined ? { inputTokens: value.usage.input_tokens } : {}),
    ...(value.usage?.output_tokens !== undefined ? { outputTokens: value.usage.output_tokens } : {}),
    ...(value.usage?.seconds !== undefined ? { audioSeconds: value.usage.seconds } : {}),
  };
  const knownUsage = Object.keys(usage).length > 0;
  return validateTranscription({
    text: value.text,
    segments: value.segments ?? [],
    model: config.id,
    ...(knownUsage ? { usage } : {}),
    warnings: knownUsage ? [] : ["Transcription provider did not report usage; cost is unknown."],
  });
}

/** OpenAI-compatible multipart ASR; the deployment supplies the endpoint and wire format. */
export function createTranscriber(inputConfig: TranscriptionConfig): TranscriptionPort {
  const config = { ...inputConfig };
  let endpoint: URL;
  try {
    endpoint = new URL(`${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !config.id.trim() || !config.wireId.trim() ||
      !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes <= 0) {
      throw new Error("Invalid configuration");
    }
  } catch {
    throw new TranscriptionError("invalid_input", "Transcription endpoint or model configuration is invalid");
  }
  return {
    async transcribe(input, signal) {
      signal?.throwIfAborted();
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > config.maxInputBytes ||
        !input.filename.trim() || input.filename.length > 255 || /[\r\n\0/\\]/.test(input.filename) ||
        !/^audio\/[a-z0-9.+-]+$/i.test(input.mimeType) ||
        (input.language !== undefined && !/^[a-z]{2,3}$/i.test(input.language))) {
        throw new TranscriptionError("invalid_input", "Transcription audio input is invalid or exceeds the configured limit");
      }
      const operationSignal = AbortSignal.any([
        ...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]);
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);
      form.set("model", config.wireId);
      form.set("response_format", config.responseFormat ?? "json");
      if (input.language) form.set("language", input.language);
      if (config.chunkingStrategy) form.set("chunking_strategy", config.chunkingStrategy);
      const headers = new Headers();
      if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST", headers, body: form, signal: operationSignal,
          // Never replay private audio or credentials at a provider redirect destination.
          redirect: "error",
        });
      } catch {
        operationSignal.throwIfAborted();
        throw new TranscriptionError("unavailable", "Transcription request failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new TranscriptionError(
          response.status === 401 || response.status === 403 ? "authentication"
            : response.status === 429 || response.status >= 500 ? "unavailable" : "unsupported",
          `Transcription provider returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        const text = await readBodyText(response, MAX_RESPONSE_BYTES);
        operationSignal.throwIfAborted();
        body = JSON.parse(text);
      } catch {
        operationSignal.throwIfAborted();
        throw new TranscriptionError("invalid_response", "Transcription response is unreadable or exceeds the size limit");
      }
      return normalizeResponse(body, config);
    },
  };
}
