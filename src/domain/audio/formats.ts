import formats from "./formats.json";

/** Shared with the private diarization service; excludes playlist demuxers. */
export const AUDIO_DECODERS: Readonly<Record<string, string>> = formats;

export function normalizeAudioMimeType(value: string): string | undefined {
  const mimeType = value.split(";", 1)[0]!.trim().toLowerCase();
  return Object.hasOwn(AUDIO_DECODERS, mimeType) ? mimeType : undefined;
}
