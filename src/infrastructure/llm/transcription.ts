import { z } from "zod";
import {
  TranscriptionError,
  validateTranscription,
  type TranscriptionPort,
  type TranscriptionUsage,
  type TranscriptSegment,
} from "@/domain/llm/transcription";
import { readBodyText } from "@/shared/httpBody";
import { AUDIO_DECODERS, normalizeAudioMimeType } from "@/domain/audio/formats";

export interface TranscriptionConfig {
  baseUrl: string;
  apiKey?: string;
  id: string;
  wireId: string;
  maxInputBytes: number;
  responseFormat?: "json" | "verbose_json" | "diarized_json";
  chunkingStrategy?: "auto";
  /** OpenRouter endpoint options, keyed by the serving provider's tag. */
  providerOptions?: Record<string, Record<string, unknown>>;
  timestampGranularities?: Array<"segment" | "word">;
}

/** Bounds one provider request, independently of the worker's total job lifetime. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const nonnegative = z.number().finite().nonnegative();
const tokens = nonnegative.int().max(Number.MAX_SAFE_INTEGER);
const speaker = z.union([z.string().min(1), tokens.transform(value => String(value))]);
const wordTiming = z.object({ start: nonnegative, end: nonnegative }).refine(value => value.end >= value.start);
const responseSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  segments: z.array(z.object({
    text: z.string(),
    start: nonnegative.optional(),
    end: nonnegative.optional(),
    speaker: speaker.optional(),
  })).optional(),
  words: z.array(z.object({ word: z.string(), start: z.unknown().optional(), end: z.unknown().optional(), speaker: speaker.optional() })).optional(),
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
  let invalidWordTiming = false;
  const words = value.words?.map(word => {
    const timing = wordTiming.safeParse({ start: word.start, end: word.end });
    if (!timing.success) invalidWordTiming = true;
    return { word: word.word, ...(word.speaker !== undefined ? { speaker: word.speaker } : {}),
      ...(timing.success ? timing.data : {}) };
  });
  // Some providers label only words; retain those boundaries rather than assigning
  // one speaker to a whole unlabelled paragraph. The complete text stays separate.
  const labelledSegments = value.segments?.length && value.segments.every(segment => !segment.text.trim() || segment.speaker !== undefined);
  const segments = !labelledSegments && words?.some(word => word.speaker !== undefined)
    ? words.reduce<TranscriptSegment[]>((result, word) => {
      const { start, end } = word;
      const timed = start !== undefined && end !== undefined;
      const previous = result.at(-1);
      if (previous && previous.speaker === word.speaker &&
        (timed ? previous.end !== undefined && previous.end <= start : previous.start === undefined)) {
        previous.text += ` ${word.word}`;
        if (timed) previous.end = end;
      } else result.push({ text: word.word, ...(timed ? { start, end } : {}),
        ...(word.speaker !== undefined ? { speaker: word.speaker } : {}) });
      return result;
    }, []) : value.segments ?? [];
  return validateTranscription({
    text: value.text,
    segments,
    model: config.id,
    ...(knownUsage ? { usage } : {}),
    warnings: [
      ...(knownUsage ? [] : ["Transcription provider did not report usage; cost is unknown."]),
      ...(invalidWordTiming
        ? ["Transcription provider returned invalid word timestamps; those timestamps were omitted while preserving text and speaker labels."] : []),
    ],
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
      const headers = new Headers();
      if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
      let body: BodyInit;
      if (config.providerOptions) {
        const mimeType = normalizeAudioMimeType(input.mimeType);
        if (!mimeType) throw new TranscriptionError("invalid_input", "Audio format has no supported provider encoding");
        headers.set("content-type", "application/json");
        body = JSON.stringify({ model: config.wireId,
          input_audio: { data: Buffer.from(input.bytes).toString("base64"), format: AUDIO_DECODERS[mimeType] },
          response_format: config.responseFormat ?? "json", ...(input.language ? { language: input.language } : {}),
          ...(config.chunkingStrategy ? { chunking_strategy: config.chunkingStrategy } : {}),
          ...(config.timestampGranularities ? { timestamp_granularities: config.timestampGranularities } : {}),
          provider: { options: config.providerOptions } });
      } else {
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);
        form.set("model", config.wireId);
        form.set("response_format", config.responseFormat ?? "json");
        if (input.language) form.set("language", input.language);
        if (config.chunkingStrategy) form.set("chunking_strategy", config.chunkingStrategy);
        for (const granularity of config.timestampGranularities ?? []) form.append("timestamp_granularities[]", granularity);
        body = form;
      }
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST", headers, body, signal: operationSignal,
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
      let responseBody: unknown;
      try {
        const text = await readBodyText(response, MAX_RESPONSE_BYTES);
        operationSignal.throwIfAborted();
        responseBody = JSON.parse(text);
      } catch {
        operationSignal.throwIfAborted();
        throw new TranscriptionError("invalid_response", "Transcription response is unreadable or exceeds the size limit");
      }
      return normalizeResponse(responseBody, config);
    },
  };
}
