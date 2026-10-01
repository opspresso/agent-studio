import type { SpeakerTimeline } from "./diarization";

export interface AudioSegment {
  index: number;
  start: number;
  end: number;
  totalSeconds: number;
  bytes: Uint8Array;
  mimeType: "audio/wav";
  filename: string;
  /** Whole-recording label supplied by the independent diarizer. */
  speaker?: string;
}

export interface AudioSegmenter {
  split(input: {
    bytes: Uint8Array;
    mimeType: string;
    segmentSeconds: number;
    maxSegmentBytes: number;
    timeline?: SpeakerTimeline;
  }, signal?: AbortSignal): AsyncGenerator<AudioSegment>;
}
