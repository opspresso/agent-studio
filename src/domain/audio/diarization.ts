import { TranscriptionError } from "../llm/transcription";
import { MAX_AUDIO_SECONDS, MAX_SPEAKER_TURNS } from "./limits";

export interface SpeakerTurn { start: number; end: number; speaker: string }
export interface SpeakerTimeline {
  /** One inference over the whole recording; labels are local to this recording. */
  duration: number;
  revision: string;
  turns: SpeakerTurn[];
  warnings: string[];
}
export interface DiarizationPort {
  analyze(input: { bytes: Uint8Array; mimeType: string }, signal?: AbortSignal): Promise<SpeakerTimeline>;
}

/** Exclusive turns are chronological and never overlap; gaps remain unattributed. */
export function validateSpeakerTimeline(value: SpeakerTimeline): SpeakerTimeline {
  const invalid = (): never => { throw new TranscriptionError("invalid_response", "Speaker timeline is invalid"); };
  if (!value || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > MAX_AUDIO_SECONDS ||
    typeof value.revision !== "string" || !value.revision.trim() || value.revision.length > 128 ||
    !Array.isArray(value.turns) || value.turns.length > MAX_SPEAKER_TURNS || !Array.isArray(value.warnings) ||
    value.warnings.length > 100 || value.warnings.some(w => typeof w !== "string" || w.length > 1000)) invalid();
  let end = 0;
  for (const turn of value.turns) {
    if (!turn || !Number.isFinite(turn.start) || !Number.isFinite(turn.end) || turn.start < end ||
      turn.end <= turn.start || turn.end > value.duration || typeof turn.speaker !== "string" ||
      !turn.speaker.trim() || turn.speaker.length > 128) invalid();
    end = turn.end;
  }
  return value;
}
