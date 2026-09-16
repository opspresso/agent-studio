import { execFile } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AUDIO_SECONDS, type AudioSegmenter } from "@/domain/audio/segmenter";
import { TranscriptionError } from "@/domain/llm/transcription";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const WAV_HEADER_BYTES = 44;
const DEMUXERS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/flac": "flac", "audio/ogg": "ogg",
};
const ALLOWED_DEMUXERS = [...new Set(Object.values(DEMUXERS))].join(",");

function decode(binary: string, args: string[], searchPath: string | undefined, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { signal, timeout: 600_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      env: { NODE_ENV: "production", ...(searchPath ? { PATH: searchPath } : {}) }, windowsHide: true }, (error) => {
      if (!error) { resolve(); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      reject(new TranscriptionError("invalid_input", "Audio decoding failed or exceeded its resource limit"));
    });
  });
}

function wav(pcm: Uint8Array): Uint8Array {
  const bytes = Buffer.alloc(WAV_HEADER_BYTES + pcm.byteLength);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(BYTES_PER_SECOND, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(pcm.byteLength, 40); bytes.set(pcm, WAV_HEADER_BYTES);
  return bytes;
}

/** Decode once to bounded PCM, then slice on sample boundaries without timestamp estimation. */
export function createAudioSegmenter(options: { binary?: string; searchPath?: string; scratchRoot?: string } = {}): AudioSegmenter {
  return {
    async *split(input, signal) {
      signal?.throwIfAborted();
      if (!Object.hasOwn(DEMUXERS, input.mimeType)) throw new TranscriptionError("unsupported", "Audio format is not supported by the decoder");
      if (!input.bytes.byteLength || !Number.isFinite(input.segmentSeconds) || input.segmentSeconds <= 0 ||
        !Number.isSafeInteger(input.maxSegmentBytes) || input.maxSegmentBytes <= WAV_HEADER_BYTES + 1) {
        throw new TranscriptionError("invalid_input", "Audio segment limits or input are invalid");
      }
      const segmentBytes = Math.floor(Math.min(input.segmentSeconds * BYTES_PER_SECOND,
        input.maxSegmentBytes - WAV_HEADER_BYTES) / 2) * 2;
      if (segmentBytes < 2) throw new TranscriptionError("invalid_input", "Audio segment duration is below one sample");
      const directory = await mkdtemp(join(options.scratchRoot ?? tmpdir(), "studio-audio-"));
      try {
        const source = join(directory, "source");
        const decoded = join(directory, "decoded.pcm");
        await writeFile(source, input.bytes, { mode: 0o600, signal });
        await decode(options.binary ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-y",
          // Source MIME is a provider hint. Probe bytes within the supported formats, excluding playlists.
          "-max_alloc", "268435456", "-protocol_whitelist", "file", "-threads", "1", "-format_whitelist", ALLOWED_DEMUXERS,
          "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn", "-threads", "1",
          "-t", String(MAX_AUDIO_SECONDS + 1), "-ar", String(SAMPLE_RATE), "-ac", "1",
          "-c:a", "pcm_s16le", "-f", "s16le", decoded], options.searchPath, signal);
        signal?.throwIfAborted();
        const size = (await stat(decoded)).size;
        if (!size || size % 2 !== 0 || size > MAX_AUDIO_SECONDS * BYTES_PER_SECOND) {
          throw new TranscriptionError("invalid_input", "Decoded audio is empty or exceeds the duration limit");
        }
        const file = await open(decoded, "r");
        try {
          for (let offset = 0, index = 0; offset < size; offset += segmentBytes, index += 1) {
            signal?.throwIfAborted();
            const pcm = Buffer.alloc(Math.min(segmentBytes, size - offset));
            let received = 0;
            while (received < pcm.length) {
              const { bytesRead } = await file.read(pcm, received, pcm.length - received, offset + received);
              if (!bytesRead) throw new TranscriptionError("invalid_input", "Decoded audio ended before its declared size");
              received += bytesRead;
            }
            yield { index, start: offset / BYTES_PER_SECOND, end: (offset + pcm.length) / BYTES_PER_SECOND,
              totalSeconds: size / BYTES_PER_SECOND, bytes: wav(pcm), mimeType: "audio/wav", filename: `segment-${index}.wav` };
          }
        } finally { await file.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
