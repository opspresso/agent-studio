import limits from "./limits.json";

/** Maximum duration of an audio source processed by the platform. */
export const MAX_AUDIO_SECONDS = limits.maxSeconds;
export const MAX_SPEAKER_TURNS = limits.maxSpeakerTurns;
export const MAX_DIARIZATION_INPUT_BYTES = limits.maxDiarizationInputBytes;
