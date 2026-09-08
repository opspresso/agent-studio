/** Audio bytes stay outside model messages; adapters consume a bounded segment. */
export interface TranscriptionInput {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  language?: string;
}

export interface TranscriptSegment {
  text: string;
  /** Seconds relative to the submitted audio, only when supplied by the model. */
  start?: number;
  end?: number;
  /** A provider label, not an identified person. */
  speaker?: string;
}

export interface TranscriptionUsage {
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  model: string;
  /** Missing usage remains unknown rather than becoming zero. */
  usage?: TranscriptionUsage;
  warnings: string[];
  /** Server-assigned accounting identity, preserved with a durable segment checkpoint. */
  accounting?: { eventId: string; date: string; costUsd?: number };
}

export interface TranscriptionPort {
  transcribe(input: TranscriptionInput, signal?: AbortSignal): Promise<TranscriptionResult>;
}

export class TranscriptionError extends Error {
  constructor(
    public readonly code: "invalid_input" | "invalid_response" | "unsupported" | "authentication" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/** Check normalized output at the adapter boundary without inventing timing or usage. */
export function validateTranscription(result: TranscriptionResult): TranscriptionResult {
  const invalid = (message: string): never => {
    throw new TranscriptionError("invalid_response", message);
  };
  if (typeof result.text !== "string" || typeof result.model !== "string" || !result.model.trim()) {
    invalid("Transcription must include text and a model identity");
  }
  if (!Array.isArray(result.segments) || !Array.isArray(result.warnings) ||
    result.warnings.some((warning) => typeof warning !== "string")) {
    invalid("Transcription segments and warnings are invalid");
  }
  for (const segment of result.segments) {
    if (!segment || typeof segment.text !== "string") invalid("Transcript segment text is invalid");
    if ((segment.start === undefined) !== (segment.end === undefined)) {
      invalid("Transcript timing must include both start and end");
    }
    if (segment.start !== undefined && segment.end !== undefined && (
      !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end < segment.start
    )) invalid("Transcript timing is invalid");
    if (segment.speaker !== undefined && (typeof segment.speaker !== "string" || !segment.speaker.trim())) {
      invalid("Transcript speaker label is invalid");
    }
  }
  if (result.usage !== undefined) {
    if (!result.usage || typeof result.usage !== "object" || Array.isArray(result.usage)) {
      invalid("Transcription usage is invalid");
    }
    for (const value of [result.usage.inputTokens, result.usage.outputTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        invalid("Transcription token usage is invalid");
      }
    }
    const seconds = result.usage.audioSeconds;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) {
      invalid("Transcription audio usage is invalid");
    }
  }
  return result;
}
