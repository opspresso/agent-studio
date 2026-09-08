export interface AudioSegment {
  index: number;
  start: number;
  end: number;
  totalSeconds: number;
  bytes: Uint8Array;
  mimeType: "audio/wav";
  filename: string;
}

export interface AudioSegmenter {
  split(input: {
    bytes: Uint8Array;
    mimeType: string;
    segmentSeconds: number;
    maxSegmentBytes: number;
  }, signal?: AbortSignal): AsyncGenerator<AudioSegment>;
}

/** Maximum duration of an audio source processed by the platform. */
export const MAX_AUDIO_SECONDS = 6 * 60 * 60;
